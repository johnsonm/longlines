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

import { z } from "zod";
import { ARCHIVE_SCHEMAS, encodeParquet, MAX_ROWS_PER_RUN, objectPath } from "./archive.ts";
import { type ErrorContext, ValidationError } from "./errors.ts";
import { sourceSchema } from "./types.ts";
import type {
  ArchiveColumns,
  ArchiveObjectStore,
  ConvertCursor,
  ConvertDb,
  NdjsonSlice,
  Source,
} from "./types.ts";
import { parseWith } from "./validate.ts";

/** Slices a run takes when the request names no limit, and the most it may name. */
export const DEFAULT_SLICES_PER_RUN = 10;
export const MAX_SLICES_PER_RUN = 100;

/**
 * Columns added after the archive moved to Parquet: no NDJSON line has them,
 * so they are null in a converted file, as they are in the database for those
 * rows. Every other column must be present in every line.
 */
const LATER_COLUMNS: ReadonlySet<string> = new Set([
  "wwff_reference",
  "wwff_reference_name",
  "wwbota_references",
  "wwbota_reference_name",
]);

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

/** One slice's NDJSON as archive_columns' column arrays (ndjsonColumns). */
export interface NdjsonColumns {
  rowCount: number;
  columns: ArchiveColumns;
}

/** What convertSlice did: the Parquet object's size, and the NDJSON path it could not delete. */
interface ConvertSliceResult {
  bytes: number;
  undeleted: string | null;
}

/** The convert-archive request body, as convertRequest reads it. */
export interface ConvertRequestBody {
  after?: ConvertCursor | null;
  limit?: number;
}

/**
 * A slice the conversion refused as it stands, though its data is sound: its
 * object is gone, the upload read back wrong, or its log row moved. Local because
 * none of errors.ts's classes says that.
 */
class SliceConvertError extends Error {
  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
    this.name = "SliceConvertError";
  }
}

const AFTER_ERROR = '"after" must be {"slice_start": <timestamp>, "source": <source>}';
const LIMIT_ERROR = `"limit" must be an integer from 1 to ${String(MAX_SLICES_PER_RUN)}`;

// Our own request body (strict). `after` is a summary's `next`, sent back as it came.
const convertRequestSchema: z.ZodType<ConvertRequestBody> = z.strictObject({
  after: z.strictObject({
    slice_start: z.string({ error: AFTER_ERROR })
      .refine((value) => !Number.isNaN(Date.parse(value)), { error: AFTER_ERROR }),
    source: sourceSchema,
  }, { error: AFTER_ERROR }).nullable().optional(),
  limit: z.int({ error: LIMIT_ERROR })
    .min(1, { error: LIMIT_ERROR })
    .max(MAX_SLICES_PER_RUN, { error: LIMIT_ERROR })
    .optional(),
});

/**
 * The request body: `{}` (or none) for the oldest slices, `{"limit": n}` for a
 * smaller or larger batch, `{"after": {"slice_start", "source"}}` to resume past
 * a cursor (a slice that keeps failing would otherwise head every batch).
 * Throws ValidationError on anything else.
 */
export function convertRequest(body: unknown): ConvertRequest {
  if (body === null || body === undefined) {
    return { after: null, limit: DEFAULT_SLICES_PER_RUN };
  }
  const request = parseWith(convertRequestSchema, body, "convertRequest: request body");
  let cursor: ConvertCursor | null = null;
  if (request.after !== undefined && request.after !== null) {
    cursor = request.after;
  }
  let slicesLimit = DEFAULT_SLICES_PER_RUN;
  if (request.limit !== undefined) {
    slicesLimit = request.limit;
  }
  return { after: cursor, limit: slicesLimit };
}

/** The stored bytes as text, gunzipped when they carry the gzip magic number. */
export async function ndjsonText(bytes: Uint8Array): Promise<string> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    // Already decoded: a GET of an object stored with Content-Encoding: gzip.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  // A copy over a plain ArrayBuffer, which Blob takes (a Uint8Array may sit on a shared one).
  const stream = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream("utf-8", { fatal: true }));
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

/**
 * `to_json`'s timestamptz (`2026-10-11T14:10:03.123456+00:00`) as epoch
 * milliseconds, rounded as archive_columns' `(extract(epoch ...) * 1000)::bigint`
 * rounds, not truncated as Date.parse would. Throws ValidationError for anything else.
 */
export function epochMillis(value: string): number {
  const millis = timestampMillis(value);
  if (millis === null) {
    throw new ValidationError(notTimestamp(value), {
      cause: undefined,
      where: "epochMillis: timestamp",
    });
  }
  return millis;
}

function notTimestamp(value: string): string {
  return `not a timestamp: ${JSON.stringify(value)}`;
}

/** epochMillis without the throw: null when the text is not to_json's timestamptz. */
function timestampMillis(value: string): number | null {
  const m =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?)$/
      .exec(value);
  let wall = NaN;
  if (m !== null) {
    wall = Date.parse(`${String(m[1])}Z`);
  }
  if (m === null || Number.isNaN(wall)) {
    return null;
  }
  const fraction = m[2];
  const sign = m[3];
  const hh = m[4];
  const mm = m[5];
  const ss = m[6];
  let offsetSeconds = 0;
  if (sign !== undefined) {
    let direction = 1;
    if (sign === "-") {
      direction = -1;
    }
    let minutes = 0;
    if (mm !== undefined) {
      minutes = Number(mm);
    }
    let seconds = 0;
    if (ss !== undefined) {
      seconds = Number(ss);
    }
    offsetSeconds = direction * (Number(hh) * 3600 + minutes * 60 + seconds);
  }
  let digits = "";
  if (fraction !== undefined) {
    digits = fraction;
  }
  const micros = Number(digits.padEnd(6, "0"));
  return wall - offsetSeconds * 1000 + Math.round(micros / 1000);
}

/** A value JSON.parse returns. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * JSON.parse, throwing ValidationError naming `where` for text that is not JSON.
 * JSON.parse has no non-throwing form, so this narrow catch only adds the place.
 */
function parseJson(text: string, where: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new ValidationError(`${where}: ${error.message}`, { cause: error, where: where });
  }
}

/**
 * The text of the line's top-level `raw_payload` value exactly as written. In
 * to_json's output that is the jsonb's own text (`{"a": 1, "b": 2.50}`), the
 * same as archive_columns' `raw_payload::text`, which JSON.stringify would not
 * reproduce. raw_payload is the last column, and `,"raw_payload":` cannot occur
 * inside an earlier string value (its quotes would be escaped). `parsed` is the
 * value JSON.parse read for it, uncopied, so the two compare exactly.
 */
function rawJsonText(line: string, parsed: JsonValue, where: string): string {
  const key = ',"raw_payload":';
  const at = line.indexOf(key);
  if (at >= 0) {
    const text = line.slice(at + key.length, line.lastIndexOf("}")).trim();
    const reparsed = parseJson(text, `${where}: raw_payload`);
    if (JSON.stringify(reparsed) === JSON.stringify(parsed)) {
      return text;
    }
  }
  throw new ValidationError(`${where}: could not locate raw_payload in the line`, {
    cause: undefined,
    where: where,
  });
}

type ColumnType = (typeof ARCHIVE_SCHEMAS)[Source][number][1];

/** One NDJSON line once its row schema passed: column name to value (undefined for a later column it lacks). */
interface NdjsonRow {
  [column: string]: JsonValue | undefined;
}

/** A column's values as ndjsonColumns collects them. */
interface ColumnTarget {
  name: string;
  json: boolean;
  values: unknown[];
}

/** The message for a value of the wrong type for its column, or for a column the line lacks. */
function columnError(type: ColumnType): (issue: z.core.$ZodRawIssue) => string {
  return function (issue: z.core.$ZodRawIssue): string {
    if (issue.input === undefined) {
      return "missing column";
    }
    return `not a ${type}: ${JSON.stringify(issue.input)}`;
  };
}

/** raw_payload: any JSON value, passed through uncopied for rawJsonText. */
const rawPayloadSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  (value) => value !== undefined,
  { error: columnError("json") },
);

/**
 * to_json's timestamptz as epoch milliseconds. A refused value is an issue, so the
 * message names the line and the column.
 */
const timestampSchema: z.ZodType<number> = z.string({ error: columnError("timestamp") })
  .transform(function (value: string, ctx: z.RefinementCtx<string>): number {
    const millis = timestampMillis(value);
    if (millis === null) {
      ctx.addIssue({ code: "custom", message: notTimestamp(value), input: value });
      return z.NEVER;
    }
    return millis;
  });

/** A column's value as archive_columns would hold it, null included. */
function columnSchema(type: ColumnType): z.ZodType<JsonValue> {
  switch (type) {
    case "timestamp":
      return timestampSchema.nullable();
    case "string":
      return z.string({ error: columnError(type) }).nullable();
    case "double":
      return z.number({ error: columnError(type) }).nullable();
    case "int32":
      // Number.isInteger, not z.int(), which also wants a safe integer.
      return z.number({ error: columnError(type) })
        .refine(Number.isInteger, { error: columnError(type) })
        .nullable();
    case "json":
      return rawPayloadSchema.nullable();
  }
}

/**
 * A source's NDJSON line, strict as archive_columns' keys are: every column but
 * LATER_COLUMNS present (null allowed), no other key. The archive's own data,
 * written by to_json before the Parquet layout.
 */
function rowSchema(source: Source): z.ZodType<NdjsonRow> {
  const shape: Record<string, z.ZodType<JsonValue | undefined>> = {};
  for (const column of ARCHIVE_SCHEMAS[source]) {
    const name = column[0];
    const schema = columnSchema(column[1]);
    if (LATER_COLUMNS.has(name)) {
      shape[name] = schema.optional();
    } else {
      shape[name] = schema;
    }
  }
  return z.strictObject(shape);
}

/**
 * One slice's NDJSON as archive_columns' column arrays, in line order: ISO
 * timestamps become epoch milliseconds, raw_payload becomes JSON text, nulls
 * stay null. Throws ValidationError on a line that is not an object, a missing
 * or unknown key, or a value of the wrong type for its column.
 */
export function ndjsonColumns(source: Source, text: string): NdjsonColumns {
  const schema = rowSchema(source);
  const targets: ColumnTarget[] = [];
  for (const column of ARCHIVE_SCHEMAS[source]) {
    targets.push({ name: column[0], json: column[1] === "json", values: [] });
  }
  let rowCount = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    rowCount += 1;
    const where = `ndjsonColumns: line ${String(rowCount)}`;
    const raw = parseJson(line, where);
    const row = parseWith(schema, raw, where);
    for (const target of targets) {
      // A later column the line lacks is null, as it is in the database.
      let value: JsonValue | undefined = row[target.name];
      if (value === undefined) {
        value = null;
      }
      if (target.json && value !== null) {
        target.values.push(rawJsonText(line, value, where));
      } else {
        target.values.push(value);
      }
    }
  }
  const columns: ArchiveColumns = {};
  for (const target of targets) {
    columns[target.name] = target.values;
  }
  return { rowCount, columns };
}

/** Converts one slice; throws (leaving the NDJSON object and its log row as they were) on any failure before the repoint. */
async function convertSlice(
  db: ConvertDb,
  store: ArchiveObjectStore,
  slice: NdjsonSlice,
): Promise<ConvertSliceResult> {
  const where = `convertSlice: ${slice.object_path}`;
  if (!slice.object_path.endsWith(".ndjson.gz")) {
    throw new ValidationError(`not an NDJSON object: ${slice.object_path}`, {
      cause: undefined,
      where: where,
    });
  }
  const stored = await store.read(slice.object_path);
  if (stored === null) {
    throw new SliceConvertError(`NDJSON object missing: ${slice.object_path}`, {
      cause: undefined,
    });
  }
  const decoded = ndjsonColumns(slice.source, await ndjsonText(stored));
  const rowCount = decoded.rowCount;
  if (rowCount !== slice.row_count) {
    throw new ValidationError(
      `row count mismatch: the object has ${String(rowCount)}, the log ${String(slice.row_count)}`,
      { cause: undefined, where: where },
    );
  }
  if (rowCount === 0) {
    throw new ValidationError("the NDJSON object has no rows", { cause: undefined, where: where });
  }
  const parquet = encodeParquet(slice.source, decoded.columns, rowCount);
  const path = objectPath(slice.source, slice.slice_start);
  // A crash after this upload leaves a Parquet object the next run overwrites.
  await store.upload(path, parquet);
  const size = await store.size(path);
  if (size !== parquet.length) {
    let readBack = "missing";
    if (size !== null) {
      readBack = String(size);
    }
    throw new SliceConvertError(
      `uploaded ${path} reads back as ${readBack}, not ${String(parquet.length)}`,
      { cause: undefined },
    );
  }
  if (!await db.repointSlice(slice, { object_path: path, bytes: parquet.length })) {
    throw new SliceConvertError("the log row changed since it was listed; left as it is", {
      cause: undefined,
    });
  }
  try {
    await store.remove(slice.object_path);
    return { bytes: parquet.length, undeleted: null };
  } catch (error) {
    // Part of the per-slice boundary: the log points at the Parquet object now, so a
    // failed delete leaves only a leftover, reported in `undeleted`, never a failed slice.
    if (!(error instanceof Error)) {
      throw error;
    }
    console.error(error.message);
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
      const result = await convertSlice(db, store, slice);
      summary.converted += 1;
      summary.rows += slice.row_count;
      summary.bytes += result.bytes;
      if (result.undeleted !== null && result.undeleted !== "") {
        summary.undeleted.push(result.undeleted);
      }
    } catch (error) {
      // Per slice (archive rules): the NDJSON object and its log row are as they were.
      // Any Error counts: ours, fetch's TypeError and timeout DOMException from the
      // bucket, the decoder's TypeError for a corrupt object, the encoder's own.
      if (!(error instanceof Error)) {
        throw error;
      }
      summary.failed.push({
        source: slice.source,
        slice_start: slice.slice_start,
        error: error.message,
      });
    }
  }
  if (last !== null && (stopped || slices.length === request.limit)) {
    summary.next = { slice_start: last.slice_start, source: last.source };
  }
  summary.duration_ms = Math.round(performance.now() - started);
  return summary;
}
