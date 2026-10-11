// supabase-js implementation of IngestDb. Every write goes through the
// security-definer RPCs defined in supabase/migrations/*_ingest_functions.sql
// except the dead-letter insert, which is a plain table insert.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  ArchiveDb,
  ArchiveLogEntry,
  ArchiveSlice,
  ArchiveStore,
  IngestDb,
  InsertedSpot,
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
    async watchedCallsigns(source: Source): Promise<string[]> {
      const { data, error } = await client.rpc("watched_callsigns", { p_source: source });
      if (error) throw new Error(`watched_callsigns failed: ${error.message}`);
      return Array.isArray(data) ? data.filter((c): c is string => typeof c === "string") : [];
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

    async sliceNdjson(source: Source, slice: ArchiveSlice) {
      const { data, error } = await client.rpc("archive_ndjson", {
        p_source: source,
        p_from: slice.slice_start,
        p_to: slice.slice_end,
      });
      if (error) throw new Error(`archive_ndjson failed: ${error.message}`);
      const row = (data as Array<{ row_count: number; ndjson: string | null }> | null)?.[0];
      return { row_count: Number(row?.row_count ?? 0), ndjson: row?.ndjson ?? "" };
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

export function createArchiveStore(client: SupabaseClient): ArchiveStore {
  return {
    async upload(path: string, bytes: Uint8Array): Promise<void> {
      const { error } = await client.storage.from("archive").upload(path, bytes, {
        contentType: "application/gzip",
        upsert: true,
      });
      if (error) throw new Error(`archive upload failed for ${path}: ${error.message}`);
    },
  };
}
