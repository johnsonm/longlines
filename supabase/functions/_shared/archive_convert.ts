// One-off (issue #174): rewrite the slices archived before 2026-10-14 as
// gzipped NDJSON (`<source>/YYYY/MM/DD/HHMM.ndjson.gz`) as Parquet in the live
// layout, so the bucket holds one dataset. Each slice is read, decoded, checked
// against archive_log.row_count, encoded with the live archive's encodeParquet,
// uploaded to objectPath and size-checked; only then does archive_repoint_slice
// point its log row at the Parquet object, and only after that succeeds is the
// NDJSON object deleted. For RBN and APRS-IS days retention has retired, the
// NDJSON object is the only copy, so every failure before the repoint leaves it
// alone. Remove this module, its handler and the convert-archive function once
// `archive_log` has no `.ndjson.gz` rows left (docs/OPERATIONS.md).

import { ARCHIVE_SCHEMAS, encodeParquet, MAX_ROWS_PER_RUN, objectPath } from "./archive.ts";
import type {
  ArchiveColumns,
  ArchiveObjectStore,
  ConvertCursor,
  ConvertDb,
  NdjsonSlice,
  Source,
} from "./types.ts";

/** Slices a run takes when the request names no limit, and the most it may name. */
export const DEFAULT_SLICES_PER_RUN = 10;
export const MAX_SLICES_PER_RUN = 100;

/**
 * Columns added after the archive moved to Parquet: no NDJSON line has them,
 * so they are null in a converted file, as they are in the database for those
 * rows. Every other column must be present in every line.
 */
const LATER_COLUMNS: ReadonlySet<string> = new Set(["wwff_reference", "wwff_reference_name"]);

export interface ConvertRequest {
  after: ConvertCursor | null;
  limit: number;
}

export interface ConvertFailure {
  source: Source;
  slice_start: string;
  error: string;
}

export interface ConvertSummary {
  converted: number;
  rows: number;
  bytes: number;
  failed: ConvertFailure[];
  /** Converted and logged, but the NDJSON object could not be deleted: delete these by hand. */
  undeleted: string[];
  /** Pass as `after` to continue past this batch; null when nothing is left after it. */
  next: ConvertCursor | null;
  duration_ms: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The request body: `{}` (or none) for the oldest slices, `{"limit": n}` for a
 * smaller or larger batch, `{"after": {"slice_start", "source"}}` to resume past
 * a cursor (a slice that keeps failing would otherwise head every batch).
 */
export function convertRequest(body: unknown): ConvertRequest {
  if (body === null || body === undefined) return { after: null, limit: DEFAULT_SLICES_PER_RUN };
  if (typeof body !== "object" || Array.isArray(body)) throw new Error("expected a JSON object");
  const { after, limit } = body as Record<string, unknown>;
  let cursor: ConvertCursor | null = null;
  if (after !== undefined && after !== null) {
    const a = after as Record<string, unknown>;
    if (
      typeof after !== "object" || Array.isArray(after) || typeof a["slice_start"] !== "string" ||
      Number.isNaN(Date.parse(a["slice_start"])) ||
      !Object.hasOwn(ARCHIVE_SCHEMAS, String(a["source"]))
    ) {
      throw new Error('"after" must be {"slice_start": <timestamp>, "source": <source>}');
    }
    cursor = { slice_start: a["slice_start"], source: a["source"] as Source };
  }
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_SLICES_PER_RUN)
  ) {
    throw new Error(`"limit" must be an integer from 1 to ${MAX_SLICES_PER_RUN}`);
  }
  return { after: cursor, limit: (limit as number | undefined) ?? DEFAULT_SLICES_PER_RUN };
}

/** The stored bytes as text, gunzipped when they carry the gzip magic number. */
export async function ndjsonText(bytes: Uint8Array): Promise<string> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    // Already decoded: a GET of an object stored with Content-Encoding: gzip.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream("utf-8", { fatal: true }));
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

/**
 * `to_json`'s timestamptz (`2026-10-11T14:10:03.123456+00:00`) as epoch
 * milliseconds, rounded as archive_columns' `(extract(epoch ...) * 1000)::bigint`
 * rounds, not truncated as Date.parse would.
 */
export function epochMillis(value: string): number {
  const m =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?)$/
      .exec(value);
  const wall = m ? Date.parse(`${m[1]}Z`) : NaN;
  if (!m || Number.isNaN(wall)) throw new Error(`not a timestamp: ${JSON.stringify(value)}`);
  const [, , fraction, sign, hh, mm, ss] = m;
  const offsetSeconds = sign === undefined
    ? 0
    : (sign === "-" ? -1 : 1) * (Number(hh) * 3600 + Number(mm ?? 0) * 60 + Number(ss ?? 0));
  const micros = Number((fraction ?? "").padEnd(6, "0"));
  return wall - offsetSeconds * 1000 + Math.round(micros / 1000);
}

/**
 * The text of the line's top-level `raw_payload` value exactly as written. In
 * to_json's output that is the jsonb's own text (`{"a": 1, "b": 2.50}`), the
 * same as archive_columns' `raw_payload::text`, which JSON.stringify would not
 * reproduce. raw_payload is the last column, and `,"raw_payload":` cannot occur
 * inside an earlier string value (its quotes would be escaped).
 */
function rawJsonText(line: string, parsed: unknown): string {
  const key = ',"raw_payload":';
  const at = line.indexOf(key);
  const end = line.lastIndexOf("}");
  const text = at < 0 ? "" : line.slice(at + key.length, end).trim();
  if (at < 0 || JSON.stringify(JSON.parse(text)) !== JSON.stringify(parsed)) {
    throw new Error("could not locate raw_payload in the line");
  }
  return text;
}

/**
 * One slice's NDJSON as archive_columns' column arrays, in line order: ISO
 * timestamps become epoch milliseconds, raw_payload becomes JSON text, nulls
 * stay null. Throws on a line that is not an object, a missing or unknown key,
 * or a value of the wrong type for its column.
 */
export function ndjsonColumns(
  source: Source,
  text: string,
): { rowCount: number; columns: ArchiveColumns } {
  const schema = ARCHIVE_SCHEMAS[source];
  const known = new Set(schema.map(([name]) => name));
  const columns: ArchiveColumns = Object.fromEntries(schema.map(([name]) => [name, []]));
  let rowCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    rowCount += 1;
    const where = `line ${rowCount}`;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${where}: ${errorMessage(error)}`);
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${where}: not a JSON object`);
    }
    const record = row as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw new Error(`${where}: unknown column ${key}`);
    }
    for (const [name, type] of schema) {
      if (!Object.hasOwn(record, name) && !LATER_COLUMNS.has(name)) {
        throw new Error(`${where}: missing column ${name}`);
      }
      const value = record[name] ?? null;
      let out: unknown = value;
      if (value !== null) {
        const bad = () => new Error(`${where}: ${name} is not a ${type}: ${JSON.stringify(value)}`);
        switch (type) {
          case "timestamp":
            if (typeof value !== "string") throw bad();
            out = epochMillis(value);
            break;
          case "json":
            out = rawJsonText(line, value);
            break;
          case "string":
            if (typeof value !== "string") throw bad();
            break;
          case "double":
            if (typeof value !== "number") throw bad();
            break;
          case "int32":
            if (!Number.isInteger(value)) throw bad();
            break;
        }
      }
      columns[name]!.push(out);
    }
  }
  return { rowCount, columns };
}

/** Converts one slice; throws (leaving the NDJSON object and its log row as they were) on any failure before the repoint. */
async function convertSlice(
  db: ConvertDb,
  store: ArchiveObjectStore,
  slice: NdjsonSlice,
): Promise<{ bytes: number; undeleted: string | null }> {
  if (!slice.object_path.endsWith(".ndjson.gz")) {
    throw new Error(`not an NDJSON object: ${slice.object_path}`);
  }
  const stored = await store.read(slice.object_path);
  if (stored === null) throw new Error(`NDJSON object missing: ${slice.object_path}`);
  const { rowCount, columns } = ndjsonColumns(slice.source, await ndjsonText(stored));
  if (rowCount !== slice.row_count) {
    throw new Error(`row count mismatch: the object has ${rowCount}, the log ${slice.row_count}`);
  }
  if (rowCount === 0) throw new Error("the NDJSON object has no rows");
  const parquet = encodeParquet(slice.source, columns, rowCount);
  const path = objectPath(slice.source, slice.slice_start);
  // A crash after this upload leaves a Parquet object the next run overwrites.
  await store.upload(path, parquet);
  const size = await store.size(path);
  if (size !== parquet.length) {
    throw new Error(`uploaded ${path} reads back as ${size ?? "missing"}, not ${parquet.length}`);
  }
  if (!await db.repointSlice(slice, { object_path: path, bytes: parquet.length })) {
    throw new Error("the log row changed since it was listed; left as it is");
  }
  try {
    await store.remove(slice.object_path);
    return { bytes: parquet.length, undeleted: null };
  } catch (error) {
    // The log points at the Parquet object now; the NDJSON object is only a leftover.
    console.error(errorMessage(error));
    return { bytes: parquet.length, undeleted: slice.object_path };
  }
}

/**
 * Converts the oldest NDJSON slices after the cursor, up to `limit` slices and
 * MAX_ROWS_PER_RUN rows. A failed slice is reported and skipped; a rerun with
 * no cursor retries it.
 */
export async function runConvert(
  db: ConvertDb,
  store: ArchiveObjectStore,
  request: ConvertRequest,
): Promise<ConvertSummary> {
  const started = performance.now();
  const summary: ConvertSummary = {
    converted: 0,
    rows: 0,
    bytes: 0,
    failed: [],
    undeleted: [],
    next: null,
    duration_ms: 0,
  };
  // A failed listing throws: the handler answers 500 and nothing was touched.
  const slices = await db.ndjsonSlices(request.after, request.limit);
  let read = 0;
  let last: NdjsonSlice | null = null;
  let stopped = false;
  for (const slice of slices) {
    if (last !== null && read + slice.row_count > MAX_ROWS_PER_RUN) {
      stopped = true;
      break;
    }
    read += slice.row_count;
    last = slice;
    try {
      const { bytes, undeleted } = await convertSlice(db, store, slice);
      summary.converted += 1;
      summary.rows += slice.row_count;
      summary.bytes += bytes;
      if (undeleted) summary.undeleted.push(undeleted);
    } catch (error) {
      summary.failed.push({
        source: slice.source,
        slice_start: slice.slice_start,
        error: errorMessage(error),
      });
    }
  }
  if (last !== null && (stopped || slices.length === request.limit)) {
    summary.next = { slice_start: last.slice_start, source: last.source };
  }
  summary.duration_ms = Math.round(performance.now() - started);
  return summary;
}
