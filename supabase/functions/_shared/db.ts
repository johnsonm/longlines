// supabase-js implementation of IngestDb. Every write goes through the
// security-definer RPCs defined in supabase/migrations/*_ingest_functions.sql
// except the dead-letter insert, which is a plain table insert. Every result is
// parsed against the shape its SQL function returns.

import { type PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { CtyData } from "./cty.ts";
import type { IotaGroup } from "./iota.ts";
import { ConfigError, FunctionCallError } from "./errors.ts";
import {
  type LicenseLoad,
  licenseLoadSchema,
  type UlsCounts,
  type UlsKind,
  type UlsRow,
} from "./uls.ts";
import {
  type ReferenceCatalogRow,
  type ReferenceFinishState,
  referenceFinishStateSchema,
  type ReferenceLoadStatus,
  referenceLoadStatusSchema,
  type ReferenceProgram,
} from "./reference_catalog.ts";
import { sourceSchema } from "./types.ts";
import type {
  AprsDb,
  AprsPacketRow,
  ArchiveColumns,
  ArchiveDb,
  ArchiveLogEntry,
  ArchiveSlice,
  ArchiveSliceColumns,
  ConvertCursor,
  ConvertDb,
  IngestDb,
  InsertedSpot,
  LicenseDb,
  NdjsonSlice,
  NormalizedSpot,
  RbnDb,
  RbnSpotRow,
  ReferenceDb,
  RepointTarget,
  Source,
  SpotFailure,
  WatchlistDb,
} from "./types.ts";
import { parseWith } from "./validate.ts";

// The schemas below are database results: loose, since a row or a jsonb object can
// gain keys across deploys. Each names the SQL that produces it.

/** The ingest_state row getLastEpoch selects. */
interface EpochRow {
  last_epoch: string | null;
}

const epochRowSchema: z.ZodType<EpochRow> = z.looseObject({ last_epoch: z.string().nullable() });

// ingest_spots: returns table (id bigint, source text, source_spot_id text); null for no rows.
const insertedSpotSchema: z.ZodType<InsertedSpot> = z.looseObject({
  id: z.number(),
  source: sourceSchema,
  source_spot_id: z.string(),
});
const insertedSpotsSchema: z.ZodType<InsertedSpot[] | null> = z
  .array(insertedSpotSchema)
  .nullable();

// match_pending_spots, ingest_rbn_spots, ingest_aprs_packets: returns int; null reads as 0.
const countSchema: z.ZodType<number | null> = z.number().nullable();

// watched_among: returns setof text. Null elements are dropped, as before.
const callsignsSchema: z.ZodType<Array<string | null> | null> = z
  .array(z.string().nullable())
  .nullable();

// fcc_license_load_status: returns the newest load as jsonb, or null before the first.
const loadStatusSchema: z.ZodType<LicenseLoad | null> = licenseLoadSchema.nullable();

// fcc_license_load_begin and begin_reference_load return bigint, fcc_license_load_rows and
// stage_reference_rows integer.
const loadNumberSchema: z.ZodType<number> = z.number();

// archive_pending_slices: returns table (slice_start timestamptz, slice_end timestamptz).
const archiveSlicesSchema: z.ZodType<ArchiveSlice[] | null> = z
  .array(z.looseObject({ slice_start: z.string(), slice_end: z.string() }))
  .nullable();

/**
 * A row of archive_columns: returns table (row_count int, columns json). The count
 * may arrive as a number or as text, and Number() reads either, as it always has.
 */
interface SliceColumnsRow {
  row_count?: number | string | null;
  columns?: ArchiveColumns | null;
}

// A column's values are whatever its SQL type encodes as in JSON. encodeParquet (archive.ts)
// checks only the timestamp columns (integers, made bigint); the others go to the writer as
// archive_columns built them.
const archiveColumnsSchema: z.ZodType<ArchiveColumns> = z.record(z.string(), z.array(z.json()));
const sliceColumnsRowsSchema: z.ZodType<SliceColumnsRow[] | null> = z
  .array(
    z.looseObject({
      row_count: z.union([z.number(), z.string()]).nullable().optional(),
      columns: archiveColumnsSchema.nullable().optional(),
    }),
  )
  .nullable();

/** A row of archive_ndjson_slices, before its count is read as a number. */
interface NdjsonSliceRow {
  source: Source;
  slice_start: string;
  slice_end: string;
  row_count: number | string;
  object_path: string;
}

// archive_ndjson_slices: returns table (source text, slice_start timestamptz,
// slice_end timestamptz, row_count int, object_path text).
const ndjsonSliceRowsSchema: z.ZodType<NdjsonSliceRow[] | null> = z
  .array(
    z.looseObject({
      source: sourceSchema,
      slice_start: z.string(),
      slice_end: z.string(),
      row_count: z.union([z.number(), z.string()]),
      object_path: z.string(),
    }),
  )
  .nullable();

// archive_repoint_slice: returns boolean.
const repointedSchema: z.ZodType<boolean | null> = z.boolean().nullable();

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    throw new ConfigError(`missing environment variable ${name}`, { cause: undefined });
  }
  return value;
}

/** The error for a failed PostgREST call: "<what> failed: <message>", with the HTTP status. */
function callFailed(what: string, error: PostgrestError, status: number): FunctionCallError {
  return new FunctionCallError(`${what} failed: ${error.message}`, { cause: error, status });
}

/** A count an RPC returned, or 0 when it returned null. */
function countOrZero(count: number | null): number {
  if (count === null) {
    return 0;
  }
  return count;
}

/** Service-role client. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the Edge runtime. */
export function createServiceClient(): SupabaseClient {
  // What createClient does, typed as the plain SupabaseClient this returns.
  return new SupabaseClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createIngestDb(client: SupabaseClient): IngestDb {
  return {
    async getLastEpoch(source: Source): Promise<string | null> {
      const result = await client
        .from("ingest_state")
        .select("last_epoch")
        .eq("source", source)
        .single();
      if (result.error !== null) {
        throw callFailed("ingest_state read", result.error, result.status);
      }
      const data: unknown = result.data;
      return parseWith(epochRowSchema, data, "getLastEpoch: ingest_state row").last_epoch;
    },

    async ingestSpots(spots: NormalizedSpot[]): Promise<InsertedSpot[]> {
      const result = await client.rpc("ingest_spots", { p_spots: spots });
      if (result.error !== null) {
        throw callFailed("ingest_spots", result.error, result.status);
      }
      const data: unknown = result.data;
      const rows = parseWith(insertedSpotsSchema, data, "ingestSpots: ingest_spots result");
      if (rows === null) {
        return [];
      }
      return rows;
    },

    async recordSpotFailures(failures: SpotFailure[]): Promise<void> {
      const result = await client.from("ingest_failures").insert(failures);
      if (result.error !== null) {
        throw callFailed("ingest_failures insert", result.error, result.status);
      }
    },

    async recordSuccess(source: Source, inserted: number, epoch: string | null): Promise<void> {
      const result = await client.rpc("record_ingest_success", {
        p_source: source,
        p_inserted: inserted,
        p_epoch: epoch,
      });
      if (result.error !== null) {
        throw callFailed("record_ingest_success", result.error, result.status);
      }
    },

    async recordFailure(source: Source, message: string): Promise<void> {
      const result = await client.rpc("record_ingest_failure", {
        p_source: source,
        p_error: message,
      });
      if (result.error !== null) {
        throw callFailed("record_ingest_failure", result.error, result.status);
      }
    },

    async matchPendingSpots(): Promise<number> {
      const result = await client.rpc("match_pending_spots");
      if (result.error !== null) {
        throw callFailed("match_pending_spots", result.error, result.status);
      }
      const data: unknown = result.data;
      return countOrZero(
        parseWith(countSchema, data, "matchPendingSpots: match_pending_spots result"),
      );
    },
  };
}

export function createWatchlistDb(client: SupabaseClient): WatchlistDb {
  return {
    async watchedAmong(source: Source, callsigns: string[]): Promise<string[]> {
      if (callsigns.length === 0) {
        return [];
      }
      const result = await client.rpc("watched_among", {
        p_source: source,
        p_callsigns: callsigns,
      });
      if (result.error !== null) {
        throw callFailed("watched_among", result.error, result.status);
      }
      const data: unknown = result.data;
      const returned = parseWith(callsignsSchema, data, "watchedAmong: watched_among result");
      const watched: string[] = [];
      if (returned !== null) {
        for (const callsign of returned) {
          if (callsign !== null) {
            watched.push(callsign);
          }
        }
      }
      return watched;
    },
  };
}

/** Replaces the country tables with a parsed cty.dat in one transaction (load_cty). */
export async function loadCty(client: SupabaseClient, data: CtyData): Promise<void> {
  const result = await client.rpc("load_cty", {
    p_version: data.version,
    p_entities: data.entities,
    p_prefixes: data.prefixes,
  });
  if (result.error !== null) {
    throw callFailed("load_cty", result.error, result.status);
  }
}

/** load_iota_groups returns the number of groups it stored. */
const iotaLoadResultSchema: z.ZodType<number> = z.number().int().nonnegative();

/** Replaces iota_groups with these groups in one transaction; returns how many it stored. */
export async function loadIotaGroups(client: SupabaseClient, groups: IotaGroup[]): Promise<number> {
  const result = await client.rpc("load_iota_groups", { p_groups: groups });
  if (result.error !== null) {
    throw callFailed("load_iota_groups", result.error, result.status);
  }
  const data: unknown = result.data;
  return parseWith(iotaLoadResultSchema, data, "loadIotaGroups: load_iota_groups result");
}

/** LicenseDb over the fcc_license_load_* RPCs. */
export function createLicenseDb(client: SupabaseClient): LicenseDb {
  /** Calls the RPC and returns its result unvalidated; throws when the call fails. */
  async function call(fn: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const result = await client.rpc(fn, args);
    if (result.error !== null) {
      throw callFailed(fn, result.error, result.status);
    }
    const data: unknown = result.data;
    return data;
  }
  return {
    async loadStatus(): Promise<LicenseLoad | null> {
      const data = await call("fcc_license_load_status", undefined);
      return parseWith(loadStatusSchema, data, "loadStatus: fcc_license_load_status result");
    },
    async beginLoad(version: string): Promise<number> {
      const data = await call("fcc_license_load_begin", { p_version: version });
      return parseWith(loadNumberSchema, data, "beginLoad: fcc_license_load_begin result");
    },
    async stageRows(load: number, kind: UlsKind, rows: UlsRow[]): Promise<number> {
      const data = await call("fcc_license_load_rows", {
        p_load: load,
        p_kind: kind,
        p_rows: rows,
      });
      return parseWith(loadNumberSchema, data, "stageRows: fcc_license_load_rows result");
    },
    // These two return void, so there is no result to read.
    async finishLoad(load: number, counts: UlsCounts): Promise<void> {
      await call("fcc_license_load_finish", { p_load: load, p_counts: counts });
    },
    async abandonLoad(load: number, error: string): Promise<void> {
      await call("fcc_license_load_abandon", { p_load: load, p_error: error });
    },
  };
}

/** ReferenceDb over the reference list load RPCs (20261026001100). */
export function createReferenceDb(client: SupabaseClient): ReferenceDb {
  /** Calls the RPC and returns its result unvalidated; throws when the call fails. */
  async function call(fn: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const result = await client.rpc(fn, args);
    if (result.error !== null) {
      throw callFailed(fn, result.error, result.status);
    }
    const data: unknown = result.data;
    return data;
  }
  return {
    async loadStatus(): Promise<ReferenceLoadStatus> {
      const data = await call("reference_load_status", undefined);
      return parseWith(
        referenceLoadStatusSchema,
        data,
        "loadStatus: reference_load_status result",
      );
    },
    async beginLoad(program: ReferenceProgram, version: string): Promise<number> {
      const data = await call("begin_reference_load", { p_program: program, p_version: version });
      return parseWith(loadNumberSchema, data, "beginLoad: begin_reference_load result");
    },
    async stageRows(load: number, rows: ReferenceCatalogRow[]): Promise<number> {
      const data = await call("stage_reference_rows", { p_load: load, p_rows: rows });
      return parseWith(loadNumberSchema, data, "stageRows: stage_reference_rows result");
    },
    async finishLoad(load: number, rows: number): Promise<ReferenceFinishState> {
      const data = await call("finish_reference_load", { p_load: load, p_rows: rows });
      return parseWith(
        referenceFinishStateSchema,
        data,
        "finishLoad: finish_reference_load result",
      );
    },
    // Returns void, so there is no result to read.
    async abandonLoad(load: number, error: string): Promise<void> {
      await call("abandon_reference_load", { p_load: load, p_error: error });
    },
  };
}

export function createRbnDb(client: SupabaseClient): RbnDb {
  return {
    async ingestRbnSpots(rows: RbnSpotRow[]): Promise<number> {
      const result = await client.rpc("ingest_rbn_spots", { p_rows: rows });
      if (result.error !== null) {
        throw callFailed("ingest_rbn_spots", result.error, result.status);
      }
      const data: unknown = result.data;
      return countOrZero(parseWith(countSchema, data, "ingestRbnSpots: ingest_rbn_spots result"));
    },
  };
}

export function createAprsDb(client: SupabaseClient): AprsDb {
  return {
    async ingestAprsPackets(rows: AprsPacketRow[]): Promise<number> {
      const result = await client.rpc("ingest_aprs_packets", { p_rows: rows });
      if (result.error !== null) {
        throw callFailed("ingest_aprs_packets", result.error, result.status);
      }
      const data: unknown = result.data;
      return countOrZero(
        parseWith(countSchema, data, "ingestAprsPackets: ingest_aprs_packets result"),
      );
    },
  };
}

export function createArchiveDb(client: SupabaseClient): ArchiveDb {
  return {
    async pendingSlices(source: Source, before: Date, limit: number): Promise<ArchiveSlice[]> {
      const result = await client.rpc("archive_pending_slices", {
        p_source: source,
        p_before: before.toISOString(),
        p_limit: limit,
      });
      if (result.error !== null) {
        throw callFailed("archive_pending_slices", result.error, result.status);
      }
      const data: unknown = result.data;
      const slices = parseWith(
        archiveSlicesSchema,
        data,
        "pendingSlices: archive_pending_slices result",
      );
      if (slices === null) {
        return [];
      }
      return slices;
    },

    async sliceColumns(source: Source, slice: ArchiveSlice): Promise<ArchiveSliceColumns> {
      const result = await client.rpc("archive_columns", {
        p_source: source,
        p_from: slice.slice_start,
        p_to: slice.slice_end,
      });
      if (result.error !== null) {
        throw callFailed("archive_columns", result.error, result.status);
      }
      const data: unknown = result.data;
      const rows = parseWith(sliceColumnsRowsSchema, data, "sliceColumns: archive_columns result");
      // An empty slice has no row, or a row with neither field.
      let rowCount: number | string = 0;
      let columns: ArchiveColumns | null = null;
      if (rows !== null) {
        const row = rows[0];
        if (row !== undefined) {
          if (row.row_count !== null && row.row_count !== undefined) {
            rowCount = row.row_count;
          }
          if (row.columns !== null && row.columns !== undefined) {
            columns = row.columns;
          }
        }
      }
      return { row_count: Number(rowCount), columns };
    },

    async logArchive(entry: ArchiveLogEntry): Promise<void> {
      const result = await client.rpc("log_archive", {
        p_source: entry.source,
        p_slice_start: entry.slice_start,
        p_slice_end: entry.slice_end,
        p_row_count: entry.row_count,
        p_bytes: entry.bytes,
        p_object_path: entry.object_path,
      });
      if (result.error !== null) {
        throw callFailed("log_archive", result.error, result.status);
      }
    },
  };
}

/** The one-off NDJSON conversion's RPCs (20261021000700). */
export function createConvertDb(client: SupabaseClient): ConvertDb {
  return {
    async ndjsonSlices(after: ConvertCursor | null, limit: number): Promise<NdjsonSlice[]> {
      let afterStart: string | null = null;
      let afterSource: Source | null = null;
      if (after !== null) {
        afterStart = after.slice_start;
        afterSource = after.source;
      }
      const result = await client.rpc("archive_ndjson_slices", {
        p_after_start: afterStart,
        p_after_source: afterSource,
        p_limit: limit,
      });
      if (result.error !== null) {
        throw callFailed("archive_ndjson_slices", result.error, result.status);
      }
      const data: unknown = result.data;
      const rows = parseWith(
        ndjsonSliceRowsSchema,
        data,
        "ndjsonSlices: archive_ndjson_slices result",
      );
      const slices: NdjsonSlice[] = [];
      if (rows === null) {
        return slices;
      }
      for (const row of rows) {
        slices.push({
          source: row.source,
          slice_start: row.slice_start,
          slice_end: row.slice_end,
          // Number() reads the count whether it arrives as a number or as text.
          row_count: Number(row.row_count),
          object_path: row.object_path,
        });
      }
      return slices;
    },

    async repointSlice(slice: NdjsonSlice, to: RepointTarget): Promise<boolean> {
      const result = await client.rpc("archive_repoint_slice", {
        p_source: slice.source,
        p_slice_start: slice.slice_start,
        p_from_path: slice.object_path,
        p_to_path: to.object_path,
        p_row_count: slice.row_count,
        p_bytes: to.bytes,
      });
      if (result.error !== null) {
        throw callFailed("archive_repoint_slice", result.error, result.status);
      }
      const data: unknown = result.data;
      const repointed = parseWith(
        repointedSchema,
        data,
        "repointSlice: archive_repoint_slice result",
      );
      return repointed === true;
    },
  };
}
