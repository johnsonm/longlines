// The archive job: every 10 minutes, write each finished slice of each source
// to the archive bucket (Backblaze B2) as a Parquet file and record it in archive_log. Postgres decides
// which slices are due and builds their column arrays (archive_pending_slices,
// archive_columns); this module only encodes Parquet, uploads and logs, so a run
// stays inside the Edge Function's 2 s CPU budget. A slice is logged only after
// its upload succeeds, so a failure leaves it pending for the next run.
// Specs: docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md and
// docs/superpowers/specs/2026-10-14-archive-parquet-design.md.

// hyparquet-writer: pure-JS Parquet encoder with built-in snappy and one
// dependency (its reader, hyparquet). No WASM, so it bundles into an Edge Function.
import { ByteWriter, parquetWrite } from "hyparquet-writer";
import type { SchemaElement } from "hyparquet-writer";
import type { ArchiveColumns, ArchiveDb, ArchiveSlice, ArchiveStore, Source } from "./types.ts";

/**
 * The sources a run takes when the request names none: the small sources first,
 * so an RBN backlog never starves them. APRS-IS is not here: at ~100 packets/s
 * it alone would fill the row budget, so its own cron job (archive-aprs) names it.
 */
export const ARCHIVE_ORDER: readonly Source[] = ["pota", "sotawatch", "dxcluster", "rbn"];
/** Every source a request may name. */
export const ARCHIVE_SOURCES: readonly Source[] = [...ARCHIVE_ORDER, "aprs"];
/** Only slices that ended this long ago are archived, so late relay batches land first. */
export const LAG_MS = 2 * 60 * 60 * 1000;
/** A run starts no new slice once it has archived this many rows. */
export const MAX_ROWS_PER_RUN = 60_000;
export const MAX_SLICES_PER_SOURCE = 24;

/** The raw_spots sources share one layout. */
const SPOT_COLUMNS: ReadonlyArray<readonly [string, ColumnType]> = [
  ["source", "string"],
  ["source_spot_id", "string"],
  ["content_hash", "string"],
  ["spot_time", "timestamp"],
  ["ingested_at", "timestamp"],
  ["callsign", "string"],
  ["spotter", "string"],
  ["frequency_khz", "double"],
  ["band", "string"],
  ["mode", "string"],
  ["mode_family", "string"],
  ["comment", "string"],
  ["pota_reference", "string"],
  ["pota_park_name", "string"],
  ["pota_location", "string"],
  ["sota_summit_ref", "string"],
  ["raw_payload", "json"],
];

export interface ArchiveSummary {
  slices: number;
  rows: number;
  bytes: number;
  empty: number;
  errors: string[];
  duration_ms: number;
}

/**
 * The sources a request body asks for: `{"sources": [...]}`, or ARCHIVE_ORDER
 * when the body is empty or names none. Throws on anything else.
 */
export function archiveSources(body: unknown): readonly Source[] {
  if (body === null || body === undefined) return ARCHIVE_ORDER;
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new Error("expected a JSON object");
  }
  const sources = (body as Record<string, unknown>)["sources"];
  if (sources === undefined) return ARCHIVE_ORDER;
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('"sources" must be a non-empty array');
  }
  for (const s of sources) {
    if (!ARCHIVE_SOURCES.includes(s as Source)) {
      throw new Error(`unknown archive source: ${JSON.stringify(s)}`);
    }
  }
  return sources as Source[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ColumnType = "timestamp" | "string" | "json" | "double" | "int32";

/**
 * The columns of each source's Parquet files, in file order, and their types.
 * The names mirror archive_columns (20261014000400); a test compares the two.
 */
export const ARCHIVE_SCHEMAS: Readonly<
  Record<Source, ReadonlyArray<readonly [string, ColumnType]>>
> = {
  rbn: [
    ["spot_time", "timestamp"],
    ["received_at", "timestamp"],
    ["spotter", "string"],
    ["callsign", "string"],
    ["frequency_khz", "double"],
    ["band", "string"],
    ["mode", "string"],
    ["mode_family", "string"],
    ["snr", "int32"],
    ["speed", "int32"],
    ["speed_unit", "string"],
    ["spot_type", "string"],
    ["line", "string"],
  ],
  aprs: [
    ["received_at", "timestamp"],
    ["source_call", "string"],
    ["destination", "string"],
    ["path", "string"],
    ["q_construct", "string"],
    ["igate", "string"],
    ["packet_type", "string"],
    ["line", "string"],
  ],
  pota: SPOT_COLUMNS,
  sotawatch: SPOT_COLUMNS,
  dxcluster: SPOT_COLUMNS,
};

/** Hive-partitioned: `<source>/year=YYYY/month=MM/day=DD/HHMM.parquet` from the slice start in UTC. */
export function objectPath(source: Source, sliceStart: string): string {
  const d = new Date(sliceStart);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${source}/year=${d.getUTCFullYear()}/month=${two(d.getUTCMonth() + 1)}/` +
    `day=${two(d.getUTCDate())}/${two(d.getUTCHours())}${two(d.getUTCMinutes())}.parquet`;
}

function schemaElement(name: string, type: ColumnType): SchemaElement {
  const optional = { name, repetition_type: "OPTIONAL" } as const;
  switch (type) {
    case "timestamp":
      // Epoch milliseconds from SQL, marked UTC so readers return instants.
      return {
        ...optional,
        type: "INT64",
        logical_type: { type: "TIMESTAMP", isAdjustedToUTC: true, unit: "MILLIS" },
      };
    case "string":
      return { ...optional, type: "BYTE_ARRAY", converted_type: "UTF8" };
    case "json":
      return { ...optional, type: "BYTE_ARRAY", converted_type: "JSON" };
    case "double":
      return { ...optional, type: "DOUBLE" };
    case "int32":
      return { ...optional, type: "INT32" };
  }
}

/** One slice's columns as a Parquet file, in a single row group. Throws on a missing or short column. */
export function encodeParquet(
  source: Source,
  columns: ArchiveColumns,
  rowCount: number,
): Uint8Array {
  const schema = ARCHIVE_SCHEMAS[source];
  const columnData = schema.map(([name, type]) => {
    const data = columns[name];
    if (!Array.isArray(data) || data.length !== rowCount) {
      throw new Error(`column ${name}: expected ${rowCount} values`);
    }
    // The writer takes INT64 values as bigint.
    if (type === "timestamp") {
      return { name, data: data.map((v) => v === null ? null : BigInt(v as number)) };
    }
    return { name, data };
  });
  const writer = new ByteWriter();
  parquetWrite({
    writer,
    columnData,
    schema: [
      { name: "root", num_children: schema.length },
      ...schema.map(([name, type]) => schemaElement(name, type)),
    ],
    rowGroupSize: Math.max(rowCount, 1),
  });
  return new Uint8Array(writer.getBuffer());
}

export async function runArchive(
  db: ArchiveDb,
  store: ArchiveStore,
  now: Date = new Date(),
  sources: readonly Source[] = ARCHIVE_ORDER,
): Promise<ArchiveSummary> {
  const started = performance.now();
  const summary: ArchiveSummary = {
    slices: 0,
    rows: 0,
    bytes: 0,
    empty: 0,
    errors: [],
    duration_ms: 0,
  };
  const before = new Date(now.getTime() - LAG_MS);

  sources: for (const source of sources) {
    let slices: ArchiveSlice[];
    try {
      slices = await db.pendingSlices(source, before, MAX_SLICES_PER_SOURCE);
    } catch (error) {
      summary.errors.push(`${source}: ${errorMessage(error)}`);
      continue;
    }
    for (const slice of slices) {
      if (summary.rows >= MAX_ROWS_PER_RUN) break sources;
      try {
        const { row_count, columns } = await db.sliceColumns(source, slice);
        if (row_count === 0) {
          await db.logArchive({ source, ...slice, row_count: 0, bytes: null, object_path: null });
          summary.empty += 1;
        } else {
          const bytes = encodeParquet(source, columns ?? {}, row_count);
          const path = objectPath(source, slice.slice_start);
          await store.upload(path, bytes);
          await db.logArchive({
            source,
            ...slice,
            row_count,
            bytes: bytes.length,
            object_path: path,
          });
          summary.rows += row_count;
          summary.bytes += bytes.length;
        }
        summary.slices += 1;
      } catch (error) {
        // Later slices of this source wait for the next run, which retries this one first.
        summary.errors.push(`${source} ${slice.slice_start}: ${errorMessage(error)}`);
        continue sources;
      }
    }
  }

  summary.duration_ms = Math.round(performance.now() - started);
  return summary;
}
