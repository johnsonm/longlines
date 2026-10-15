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
  IngestDb,
  InsertedSpot,
  LicenseDb,
  NormalizedSpot,
  RbnDb,
  RbnSpotRow,
  Source,
  SpotFailure,
  WatchlistDb,
} from "./types.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing environment variable ${name}`);
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
      const { data, error } = await client
        .from("ingest_state")
        .select("last_epoch")
        .eq("source", source)
        .single();
      if (error) throw new Error(`ingest_state read failed: ${error.message}`);
      return typeof data.last_epoch === "string" ? data.last_epoch : null;
    },

    async ingestSpots(spots: NormalizedSpot[]): Promise<InsertedSpot[]> {
      const { data, error } = await client.rpc("ingest_spots", { p_spots: spots });
      if (error) throw new Error(`ingest_spots failed: ${error.message}`);
      return (data ?? []) as InsertedSpot[];
    },

    async recordSpotFailures(failures: SpotFailure[]): Promise<void> {
      const { error } = await client.from("ingest_failures").insert(failures);
      if (error) throw new Error(`ingest_failures insert failed: ${error.message}`);
    },

    async recordSuccess(source: Source, inserted: number, epoch: string | null): Promise<void> {
      const { error } = await client.rpc("record_ingest_success", {
        p_source: source,
        p_inserted: inserted,
        p_epoch: epoch,
      });
      if (error) throw new Error(`record_ingest_success failed: ${error.message}`);
    },

    async recordFailure(source: Source, message: string): Promise<void> {
      const { error } = await client.rpc("record_ingest_failure", {
        p_source: source,
        p_error: message,
      });
      if (error) throw new Error(`record_ingest_failure failed: ${error.message}`);
    },

    async matchPendingSpots(): Promise<number> {
      const { data, error } = await client.rpc("match_pending_spots");
      if (error) throw new Error(`match_pending_spots failed: ${error.message}`);
      return typeof data === "number" ? data : 0;
    },
  };
}

export function createWatchlistDb(client: SupabaseClient): WatchlistDb {
  return {
    async watchedAmong(source: Source, callsigns: string[]): Promise<string[]> {
      if (callsigns.length === 0) return [];
      const { data, error } = await client.rpc("watched_among", {
        p_source: source,
        p_callsigns: callsigns,
      });
      if (error) throw new Error(`watched_among failed: ${error.message}`);
      return Array.isArray(data) ? data.filter((c): c is string => typeof c === "string") : [];
    },
  };
}

/** Replaces the country tables with a parsed cty.dat in one transaction (load_cty). */
export async function loadCty(client: SupabaseClient, data: CtyData): Promise<void> {
  const { error } = await client.rpc("load_cty", {
    p_version: data.version,
    p_entities: data.entities,
    p_prefixes: data.prefixes,
  });
  if (error) throw new Error(`load_cty failed: ${error.message}`);
}

/** LicenseDb over the fcc_license_load_* RPCs. */
export function createLicenseDb(client: SupabaseClient): LicenseDb {
  async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data as T;
  }
  return {
    loadStatus: () => call<LicenseLoad | null>("fcc_license_load_status"),
    beginLoad: (version) => call<number>("fcc_license_load_begin", { p_version: version }),
    stageRows: (load, kind, rows) =>
      call<number>("fcc_license_load_rows", { p_load: load, p_kind: kind, p_rows: rows }),
    async finishLoad(load, counts) {
      await call<null>("fcc_license_load_finish", { p_load: load, p_counts: counts });
    },
    async abandonLoad(load, error) {
      await call<null>("fcc_license_load_abandon", { p_load: load, p_error: error });
    },
  };
}

export function createRbnDb(client: SupabaseClient): RbnDb {
  return {
    async ingestRbnSpots(rows: RbnSpotRow[]): Promise<number> {
      const { data, error } = await client.rpc("ingest_rbn_spots", { p_rows: rows });
      if (error) throw new Error(`ingest_rbn_spots failed: ${error.message}`);
      return typeof data === "number" ? data : 0;
    },
  };
}

export function createAprsDb(client: SupabaseClient): AprsDb {
  return {
    async ingestAprsPackets(rows: AprsPacketRow[]): Promise<number> {
      const { data, error } = await client.rpc("ingest_aprs_packets", { p_rows: rows });
      if (error) throw new Error(`ingest_aprs_packets failed: ${error.message}`);
      return typeof data === "number" ? data : 0;
    },
  };
}

export function createArchiveDb(client: SupabaseClient): ArchiveDb {
  return {
    async pendingSlices(source: Source, before: Date, limit: number): Promise<ArchiveSlice[]> {
      const { data, error } = await client.rpc("archive_pending_slices", {
        p_source: source,
        p_before: before.toISOString(),
        p_limit: limit,
      });
      if (error) throw new Error(`archive_pending_slices failed: ${error.message}`);
      return (data ?? []) as ArchiveSlice[];
    },

    async sliceColumns(source: Source, slice: ArchiveSlice) {
      const { data, error } = await client.rpc("archive_columns", {
        p_source: source,
        p_from: slice.slice_start,
        p_to: slice.slice_end,
      });
      if (error) throw new Error(`archive_columns failed: ${error.message}`);
      const row = (data as Array<{ row_count: number; columns: ArchiveColumns | null }> | null)
        ?.[0];
      return { row_count: Number(row?.row_count ?? 0), columns: row?.columns ?? null };
    },

    async logArchive(entry: ArchiveLogEntry): Promise<void> {
      const { error } = await client.rpc("log_archive", {
        p_source: entry.source,
        p_slice_start: entry.slice_start,
        p_slice_end: entry.slice_end,
        p_row_count: entry.row_count,
        p_bytes: entry.bytes,
        p_object_path: entry.object_path,
      });
      if (error) throw new Error(`log_archive failed: ${error.message}`);
    },
  };
}
