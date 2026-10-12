import type { ModeFamily } from "./modes.ts";
import type { LicenseLoad, UlsCounts, UlsKind, UlsRow } from "./uls.ts";

export type Source = "pota" | "sotawatch" | "rbn" | "dxcluster";

/** A JSON object as received from an upstream feed. Fields are validated at use. */
export type JsonObject = Record<string, unknown>;

/**
 * One row to insert into raw_spots. Keys match the column names so the batch
 * can be passed straight to the ingest_spots RPC.
 */
export interface NormalizedSpot {
  source: Source;
  source_spot_id: string;
  content_hash: string;
  spot_time: string; // ISO 8601 UTC
  callsign: string;
  spotter: string | null;
  frequency_khz: number;
  band: string | null;
  mode: string | null;
  mode_family: ModeFamily | null;
  comment: string;
  pota_reference: string | null;
  pota_park_name: string | null;
  pota_location: string | null;
  sota_summit_ref: string | null;
  raw_payload: JsonObject;
}

/**
 * One row for rbn_spots, every RBN spot the relay forwards. Keys match the
 * columns so the batch can be passed straight to the ingest_rbn_spots RPC.
 */
export interface RbnSpotRow {
  spot_time: string; // ISO 8601 UTC
  received_at: string; // ISO 8601 UTC
  spotter: string;
  callsign: string;
  frequency_khz: number;
  band: string | null;
  mode: string | null;
  mode_family: ModeFamily | null;
  snr: number;
  speed: number;
  speed_unit: "WPM" | "BPS";
  spot_type: string;
  line: string;
}

/** Why a well-formed upstream spot was intentionally not stored. */
export type SkipReason = "too_old" | "test_comment" | "not_normal";

export type NormalizeResult =
  | { kind: "spot"; spot: NormalizedSpot }
  | { kind: "skip"; reason: SkipReason };

/**
 * A source adapter. parseFeed and normalize are pure so they can be tested
 * against fixtures; fetchSpots (and fetchEpoch) do the network I/O.
 */
export interface SourceAdapter {
  readonly source: Source;
  fetchSpots(): Promise<unknown>;
  /** Only sources with a cheap "anything new?" endpoint implement this. */
  fetchEpoch?(): Promise<string>;
  /** Validate the response body shape and return the spots in processing order. Throws on bad shape. */
  parseFeed(body: unknown): JsonObject[];
  /** Normalize one upstream spot. Throws when the spot cannot be processed. */
  normalize(raw: JsonObject, now: Date): Promise<NormalizeResult>;
}

/** Response body returned by an ingest function. */
export interface IngestSummary {
  source: Source;
  epoch_unchanged: boolean;
  fetched: number;
  inserted: number;
  skipped: Record<SkipReason, number>;
  failed: number;
  /** Rows written to rbn_spots by a push (RBN only). */
  stored?: number;
  /** Deliveries created by the matcher, or null when it did not run. */
  matched: number | null;
  match_error?: string;
  duration_ms: number;
}

/** A row returned by the ingest_spots RPC: one per newly inserted spot. */
export interface InsertedSpot {
  id: number;
  source: Source;
  source_spot_id: string;
}

/** One unprocessable upstream spot, destined for ingest_failures. */
export interface SpotFailure {
  source: Source;
  error: string;
  raw_payload: JsonObject;
}

/** Database operations the orchestrator needs. Implemented by db.ts over supabase-js. */
export interface IngestDb {
  getLastEpoch(source: Source): Promise<string | null>;
  ingestSpots(spots: NormalizedSpot[]): Promise<InsertedSpot[]>;
  recordSpotFailures(failures: SpotFailure[]): Promise<void>;
  recordSuccess(source: Source, inserted: number, epoch: string | null): Promise<void>;
  recordFailure(source: Source, error: string): Promise<void>;
  /** Run the matcher over queued spot_events; returns deliveries created. */
  matchPendingSpots(): Promise<number>;
}

/** Which pushed stations a subscription names, by the matcher's callsign rule (exact or base call). */
export interface WatchlistDb {
  /** The members of `callsigns` that an enabled subscription accepting `source` names. */
  watchedAmong(source: Source, callsigns: string[]): Promise<string[]>;
}

/** Bulk storage of every RBN spot. Implemented by db.ts over ingest_rbn_spots. */
export interface RbnDb {
  /** Inserts the batch, skipping spots already stored; returns rows inserted. */
  ingestRbnSpots(rows: RbnSpotRow[]): Promise<number>;
}

/** One archive slice, [slice_start, slice_end), as ISO 8601 strings from Postgres. */
export interface ArchiveSlice {
  slice_start: string;
  slice_end: string;
}

/** An archived slice for archive_log. bytes and object_path are null for an empty slice. */
export interface ArchiveLogEntry extends ArchiveSlice {
  source: Source;
  row_count: number;
  bytes: number | null;
  object_path: string | null;
}

/** Database operations the archive job needs. Implemented by db.ts over the archive RPCs. */
export interface ArchiveDb {
  /** Slices of a source that ended before `before` and are not logged, oldest first. */
  pendingSlices(source: Source, before: Date, limit: number): Promise<ArchiveSlice[]>;
  /** One slice as NDJSON (no trailing newline) and its row count. */
  sliceNdjson(source: Source, slice: ArchiveSlice): Promise<{ row_count: number; ndjson: string }>;
  logArchive(entry: ArchiveLogEntry): Promise<void>;
}

/** Where archive objects go. Implemented by db.ts over the private `archive` bucket. */
export interface ArchiveStore {
  /** Writes the object, replacing one already at that path. */
  upload(path: string, bytes: Uint8Array): Promise<void>;
}

/** The FCC license load's staging RPCs (20261012000050). Implemented by db.ts. */
export interface LicenseDb {
  /** The newest FCC load, or null before the first. */
  loadStatus(): Promise<LicenseLoad | null>;
  /** Starts a load, failing any unfinished one; returns its id. */
  beginLoad(version: string): Promise<number>;
  /** Stages one batch; returns rows inserted (a record already staged is skipped). */
  stageRows(load: number, kind: UlsKind, rows: UlsRow[]): Promise<number>;
  /** Marks the load ready for apply_license_loads; throws when the staged counts differ. */
  finishLoad(load: number, counts: UlsCounts): Promise<void>;
}
