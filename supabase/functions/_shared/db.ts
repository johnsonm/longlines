// supabase-js implementation of IngestDb. Every write goes through the
// security-definer RPCs defined in supabase/migrations/*_ingest_functions.sql
// except the dead-letter insert, which is a plain table insert.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CtyData } from "./cty.ts";
import type { LicenseLoad } from "./uls.ts";
import type {
  AprsDb,
  AprsPacketRow,
  ArchiveColumns,
  ArchiveDb,
  ArchiveLogEntry,
  ArchiveSlice,
  ConvertCursor,
  ConvertDb,
  IngestDb,
  InsertedSpot,
  LicenseDb,
  NdjsonSlice,
  NormalizedSpot,
  RbnDb,
  RbnSpotRow,
  Source,
  SpotFailure,
  WatchlistDb,
} from "./types.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    throw new Error(`missing environment variable ${name}`);
  }
  return value;
}

/** Service-role client. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the Edge runtime. */
export function createServiceClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
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
        throw new Error(`ingest_state read failed: ${result.error.message}`);
      }
      if (typeof result.data.last_epoch === "string") {
        return result.data.last_epoch;
      }
      return null;
    },

    async ingestSpots(spots: NormalizedSpot[]): Promise<InsertedSpot[]> {
      const result = await client.rpc("ingest_spots", { p_spots: spots });
      if (result.error !== null) {
        throw new Error(`ingest_spots failed: ${result.error.message}`);
      }
      if (result.data === null || result.data === undefined) {
        return [];
      }
      return result.data as InsertedSpot[];
    },

    async recordSpotFailures(failures: SpotFailure[]): Promise<void> {
      const result = await client.from("ingest_failures").insert(failures);
      if (result.error !== null) {
        throw new Error(`ingest_failures insert failed: ${result.error.message}`);
      }
    },

    async recordSuccess(source: Source, inserted: number, epoch: string | null): Promise<void> {
      const result = await client.rpc("record_ingest_success", {
        p_source: source,
        p_inserted: inserted,
        p_epoch: epoch,
      });
      if (result.error !== null) {
        throw new Error(`record_ingest_success failed: ${result.error.message}`);
      }
    },

    async recordFailure(source: Source, message: string): Promise<void> {
      const result = await client.rpc("record_ingest_failure", {
        p_source: source,
        p_error: message,
      });
      if (result.error !== null) {
        throw new Error(`record_ingest_failure failed: ${result.error.message}`);
      }
    },

    async matchPendingSpots(): Promise<number> {
      const result = await client.rpc("match_pending_spots");
      if (result.error !== null) {
        throw new Error(`match_pending_spots failed: ${result.error.message}`);
      }
      if (typeof result.data === "number") {
        return result.data;
      }
      return 0;
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
        throw new Error(`watched_among failed: ${result.error.message}`);
      }
      if (Array.isArray(result.data)) {
        return result.data.filter((c): c is string => typeof c === "string");
      }
      return [];
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
    throw new Error(`load_cty failed: ${result.error.message}`);
  }
}

/** LicenseDb over the fcc_license_load_* RPCs. */
export function createLicenseDb(client: SupabaseClient): LicenseDb {
  async function call<T>(fn: string, args: Record<string, unknown> | undefined): Promise<T> {
    const result = await client.rpc(fn, args);
    if (result.error !== null) {
      throw new Error(`${fn} failed: ${result.error.message}`);
    }
    return result.data as T;
  }
  return {
    loadStatus: () => call<LicenseLoad | null>("fcc_license_load_status", undefined),
    beginLoad: (version) => call<number>("fcc_license_load_begin", { p_version: version }),
    stageRows: (load, kind, rows) =>
      call<number>("fcc_license_load_rows", { p_load: load, p_kind: kind, p_rows: rows }),
    async finishLoad(load, counts): Promise<void> {
      await call<null>("fcc_license_load_finish", { p_load: load, p_counts: counts });
    },
    async abandonLoad(load, error): Promise<void> {
      await call<null>("fcc_license_load_abandon", { p_load: load, p_error: error });
    },
  };
}

export function createRbnDb(client: SupabaseClient): RbnDb {
  return {
    async ingestRbnSpots(rows: RbnSpotRow[]): Promise<number> {
      const result = await client.rpc("ingest_rbn_spots", { p_rows: rows });
      if (result.error !== null) {
        throw new Error(`ingest_rbn_spots failed: ${result.error.message}`);
      }
      if (typeof result.data === "number") {
        return result.data;
      }
      return 0;
    },
  };
}

export function createAprsDb(client: SupabaseClient): AprsDb {
  return {
    async ingestAprsPackets(rows: AprsPacketRow[]): Promise<number> {
      const result = await client.rpc("ingest_aprs_packets", { p_rows: rows });
      if (result.error !== null) {
        throw new Error(`ingest_aprs_packets failed: ${result.error.message}`);
      }
      if (typeof result.data === "number") {
        return result.data;
      }
      return 0;
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
        throw new Error(`archive_pending_slices failed: ${result.error.message}`);
      }
      if (result.data === null || result.data === undefined) {
        return [];
      }
      return result.data as ArchiveSlice[];
    },

    async sliceColumns(
      source: Source,
      slice: ArchiveSlice,
    ): Promise<{ row_count: number; columns: ArchiveColumns | null }> {
      const result = await client.rpc("archive_columns", {
        p_source: source,
        p_from: slice.slice_start,
        p_to: slice.slice_end,
      });
      if (result.error !== null) {
        throw new Error(`archive_columns failed: ${result.error.message}`);
      }
      const rows = result.data as
        | Array<{ row_count: number; columns: ArchiveColumns | null }>
        | null;
      // row_count is bigint in SQL; Number() keeps the result a number whatever the client returns.
      let rowCount: unknown = 0;
      let columns: ArchiveColumns | null = null;
      if (rows !== null && rows !== undefined) {
        const row = rows[0];
        if (row !== null && row !== undefined) {
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
        throw new Error(`log_archive failed: ${result.error.message}`);
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
      if (after !== null && after !== undefined) {
        if (after.slice_start !== null && after.slice_start !== undefined) {
          afterStart = after.slice_start;
        }
        if (after.source !== null && after.source !== undefined) {
          afterSource = after.source;
        }
      }
      const result = await client.rpc("archive_ndjson_slices", {
        p_after_start: afterStart,
        p_after_source: afterSource,
        p_limit: limit,
      });
      if (result.error !== null) {
        throw new Error(`archive_ndjson_slices failed: ${result.error.message}`);
      }
      if (result.data === null || result.data === undefined) {
        return [];
      }
      const slices: NdjsonSlice[] = [];
      for (const s of result.data as NdjsonSlice[]) {
        // row_count is bigint in SQL; Number() keeps it a number whatever the client returns.
        const rowCount: unknown = s.row_count;
        slices.push(Object.assign({}, s, { row_count: Number(rowCount) }));
      }
      return slices;
    },

    async repointSlice(
      slice: NdjsonSlice,
      to: { object_path: string; bytes: number },
    ): Promise<boolean> {
      const result = await client.rpc("archive_repoint_slice", {
        p_source: slice.source,
        p_slice_start: slice.slice_start,
        p_from_path: slice.object_path,
        p_to_path: to.object_path,
        p_row_count: slice.row_count,
        p_bytes: to.bytes,
      });
      if (result.error !== null) {
        throw new Error(`archive_repoint_slice failed: ${result.error.message}`);
      }
      return result.data === true;
    },
  };
}
