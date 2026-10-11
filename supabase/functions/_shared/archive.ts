// The archive job: every 10 minutes, write each finished slice of each source
// to Storage as gzipped NDJSON and record it in archive_log. Postgres decides
// which slices are due and builds their NDJSON (archive_pending_slices,
// archive_ndjson); this module only gzips, uploads and logs, so a run stays
// inside the Edge Function's 2 s CPU budget (measured: ~0.3 s for a full RBN
// hour). A slice is logged only after its upload succeeds, so a failure leaves
// it pending for the next run. Spec: docs/superpowers/specs/2026-10-11-rbn-firehose-archive-design.md.

import type { ArchiveDb, ArchiveSlice, ArchiveStore, Source } from "./types.ts";

/** POTA and SOTAwatch first: they are tiny, so an RBN backlog never starves them. */
export const ARCHIVE_ORDER: readonly Source[] = ["pota", "sotawatch", "rbn"];
/** Only slices that ended this long ago are archived, so late relay batches land first. */
export const LAG_MS = 2 * 60 * 60 * 1000;
/** A run starts no new slice once it has archived this many rows. */
export const MAX_ROWS_PER_RUN = 60_000;
export const MAX_SLICES_PER_SOURCE = 24;

export interface ArchiveSummary {
  slices: number;
  rows: number;
  bytes: number;
  empty: number;
  errors: string[];
  duration_ms: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<source>/YYYY/MM/DD/HHMM.ndjson.gz` from the slice start in UTC. */
export function objectPath(source: Source, sliceStart: string): string {
  const d = new Date(sliceStart);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${source}/${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/` +
    `${two(d.getUTCHours())}${two(d.getUTCMinutes())}.ndjson.gz`;
}

export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function runArchive(
  db: ArchiveDb,
  store: ArchiveStore,
  now: Date = new Date(),
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

  sources: for (const source of ARCHIVE_ORDER) {
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
        const { row_count, ndjson } = await db.sliceNdjson(source, slice);
        if (row_count === 0) {
          await db.logArchive({ source, ...slice, row_count: 0, bytes: null, object_path: null });
          summary.empty += 1;
        } else {
          const bytes = await gzip(`${ndjson}\n`);
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
