// supabase-js implementation of IngestDb. Every write goes through the
// security-definer RPCs defined in supabase/migrations/*_ingest_functions.sql
// except the dead-letter insert, which is a plain table insert.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  IngestDb,
  InsertedSpot,
  NormalizedSpot,
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
