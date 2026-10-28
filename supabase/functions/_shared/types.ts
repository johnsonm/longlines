import { z } from "zod";
import type { AprsPacketType } from "./aprs.ts";
import type { ModeFamily } from "./modes.ts";
import type { LicenseLoad, UlsCounts, UlsKind, UlsRow } from "./uls.ts";
import type {
  ReferenceCatalogRow,
  ReferenceFinishState,
  ReferenceLoadStatus,
  ReferenceProgram,
} from "./reference_catalog.ts";

export type Source = "pota" | "sotawatch" | "rbn" | "dxcluster" | "aprs" | "wwff" | "wwbota";

/** A source name as the database stores it (raw_spots_source_check plus aprs). */
export const sourceSchema: z.ZodType<Source> = z.enum([
  "pota",
  "sotawatch",
  "rbn",
  "dxcluster",
  "aprs",
  "wwff",
  "wwbota",
]);

/** A JSON object as received from an upstream feed. Fields are validated at use. */
export type JsonObject = Record<string, unknown>;

/**
 * A feed item that is a JSON object (not null, not an array), passed through as
 * received. Not z.looseObject: that returns a copy, and the copy loses an own
 * "__proto__" key, while raw_payload must be the item exactly as upstream sent it.
 */
export const jsonObjectSchema: z.ZodType<JsonObject> = z.custom<JsonObject>(
  isJsonObject,
  "expected an object",
);

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  wwff_reference: string | null;
  wwff_reference_name: string | null;
  /** Every WWBOTA bunker the spot names, in the feed's order; wwbota spots only. */
  wwbota_references: string[] | null;
  /** The first bunker's name. */
  wwbota_reference_name: string | null;
  /** The IOTA reference a DX Cluster comment gives (EU-005); ingest_spots names it. */
  iota_reference: string | null;
  raw_payload: JsonObject;
}

/**
 * One row for rbn_spots, every RBN spot the inbound worker forwards. Keys match the
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

/**
 * One row for aprs_packets, every APRS-IS packet the inbound worker forwards. Keys match
 * the columns so the batch can be passed straight to the ingest_aprs_packets RPC.
 */
export interface AprsPacketRow {
  received_at: string; // ISO 8601 UTC
  source_call: string;
  destination: string;
  path: string;
  q_construct: string | null;
  igate: string | null;
  packet_type: AprsPacketType;
  line: string;
}

/** Why a well-formed upstream spot was intentionally not stored. */
export type SkipReason = "too_old" | "test_comment" | "not_normal";

/** normalize kept the spot. */
export interface SpotResult {
  kind: "spot";
  spot: NormalizedSpot;
}

/** normalize dropped the spot on purpose. */
export interface SkipResult {
  kind: "skip";
  reason: SkipReason;
}

export type NormalizeResult = SpotResult | SkipResult;

/**
 * A source adapter. parseFeed and normalize are pure so they can be tested
 * against fixtures; fetchSpots (and fetchEpoch) do the network I/O.
 */
export interface SourceAdapter {
  readonly source: Source;
  fetchSpots(): Promise<unknown>;
  /** Only sources with a cheap "anything new?" endpoint implement this. */
  fetchEpoch?(): Promise<string>;
  /**
   * Validate the response body's envelope and return the spots, as received, in
   * processing order. Throws ValidationError on a bad envelope; normalize checks each spot.
   */
  parseFeed(body: unknown): JsonObject[];
  /**
   * Normalize one upstream spot. Throws ValidationError when the spot cannot be
   * processed, which runIngest records as one ingest_failures row.
   */
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
  /** Rows written to rbn_spots or aprs_packets by a push (RBN and APRS only). */
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

/** Bulk storage of every APRS-IS packet. Implemented by db.ts over ingest_aprs_packets. */
export interface AprsDb {
  /** Inserts the batch, skipping packets already stored; returns rows inserted. */
  ingestAprsPackets(rows: AprsPacketRow[]): Promise<number>;
}

/** One archive slice, [slice_start, slice_end), as ISO 8601 strings from Postgres. */
export interface ArchiveSlice {
  slice_start: string;
  slice_end: string;
}

/** A slice's columns from archive_columns: name to values, one per row. */
export type ArchiveColumns = Record<string, unknown[]>;

/** An archived slice for archive_log. bytes and object_path are null for an empty slice. */
export interface ArchiveLogEntry extends ArchiveSlice {
  source: Source;
  row_count: number;
  bytes: number | null;
  object_path: string | null;
}

/** One slice from archive_columns: its row count and its columns (null when empty). */
export interface ArchiveSliceColumns {
  row_count: number;
  columns: ArchiveColumns | null;
}

/** Database operations the archive job needs. Implemented by db.ts over the archive RPCs. */
export interface ArchiveDb {
  /** Slices of a source that ended before `before` and are not logged, oldest first. */
  pendingSlices(source: Source, before: Date, limit: number): Promise<ArchiveSlice[]>;
  /** One slice as column arrays in row order (null when empty) and its row count. */
  sliceColumns(source: Source, slice: ArchiveSlice): Promise<ArchiveSliceColumns>;
  logArchive(entry: ArchiveLogEntry): Promise<void>;
}

/** Where archive objects go. Implemented by archive_store.ts over an S3-compatible bucket (B2 hosted). */
export interface ArchiveStore {
  /** Writes the object, replacing one already at that path. */
  upload(path: string, bytes: Uint8Array): Promise<void>;
}

/** The archive bucket with reads and deletes, for the one-off NDJSON conversion. */
export interface ArchiveObjectStore extends ArchiveStore {
  /** The object's bytes as stored, or null when there is none. */
  read(path: string): Promise<Uint8Array | null>;
  /** The object's size in bytes, or null when there is none. */
  size(path: string): Promise<number | null>;
  /** Deletes the object; one already gone is not an error. */
  remove(path: string): Promise<void>;
}

/** An archive_log row still pointing at a gzipped NDJSON object (archive_ndjson_slices). */
export interface NdjsonSlice extends ArchiveSlice {
  source: Source;
  row_count: number;
  object_path: string;
}

/** Where a conversion batch resumes: after this slice, in (slice_start, source) order. */
export interface ConvertCursor {
  slice_start: string;
  source: Source;
}

/** The Parquet object a converted slice's log row is pointed at. */
export interface RepointTarget {
  object_path: string;
  bytes: number;
}

/** Database operations the NDJSON conversion needs. Implemented by db.ts (20261021000700). */
export interface ConvertDb {
  /** Log rows still on NDJSON after the cursor (all when null), oldest first. */
  ndjsonSlices(after: ConvertCursor | null, limit: number): Promise<NdjsonSlice[]>;
  /**
   * Points the log row at the Parquet object, only while it still names `from`
   * and has `row_count` rows. False when nothing matched.
   */
  repointSlice(slice: NdjsonSlice, to: RepointTarget): Promise<boolean>;
}

/** The FCC license load's staging RPCs (20261012000050). Implemented by db.ts. */
export interface LicenseDb {
  /** The newest FCC load, or null before the first. */
  loadStatus(): Promise<LicenseLoad | null>;
  /** Starts a load, failing any unfinished one; returns its id. */
  beginLoad(version: string): Promise<number>;
  /**
   * Stages one batch (a record already staged is skipped); returns the rows of
   * that file staged so far, so a retried batch reports the right total.
   */
  stageRows(load: number, kind: UlsKind, rows: UlsRow[]): Promise<number>;
  /** Marks the load ready for apply_license_loads; throws when the staged counts differ. */
  finishLoad(load: number, counts: UlsCounts): Promise<void>;
  /** Fails a load the inbound worker gave up on and empties staging. */
  abandonLoad(load: number, error: string): Promise<void>;
}

/** The reference list load's staging RPCs (20261026001100). Implemented by db.ts. */
export interface ReferenceDb {
  /** Per program, the last applied load and the newest one. */
  loadStatus(): Promise<ReferenceLoadStatus>;
  /** Starts a load of one program's list, abandoning its open one; returns its id. */
  beginLoad(program: ReferenceProgram, version: string): Promise<number>;
  /**
   * Stages one batch (a reference already staged in the load is skipped); returns the load's rows
   * staged so far, so a retried batch reports the right total.
   */
  stageRows(load: number, rows: ReferenceCatalogRow[]): Promise<number>;
  /** Ends staging: finished, or refused when incomplete or below the floor. */
  finishLoad(load: number, rows: number): Promise<ReferenceFinishState>;
  /** Abandons a load the inbound worker gave up on and deletes its staged rows. */
  abandonLoad(load: number, error: string): Promise<void>;
}
