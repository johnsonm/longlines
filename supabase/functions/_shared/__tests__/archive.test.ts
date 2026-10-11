import { assertEquals } from "@std/assert";
import { gzip, LAG_MS, MAX_ROWS_PER_RUN, objectPath, runArchive } from "../archive.ts";
import type { ArchiveDb, ArchiveLogEntry, ArchiveSlice, ArchiveStore, Source } from "../types.ts";

const NOW = new Date("2026-10-11T20:05:00Z");

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function slice(start: string, minutes: number): ArchiveSlice {
  const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();
  return { slice_start: new Date(start).toISOString(), slice_end: end };
}

function fakes(
  options: {
    pending?: Partial<Record<Source, ArchiveSlice[]>>;
    rows?: (source: Source, s: ArchiveSlice) => number;
    failUpload?: (path: string) => boolean;
  } = {},
) {
  const calls = {
    pending: [] as Array<[Source, string, number]>,
    uploads: [] as Array<{ path: string; bytes: Uint8Array }>,
    logs: [] as ArchiveLogEntry[],
    events: [] as string[],
  };
  const db: ArchiveDb = {
    pendingSlices(source, before, limit) {
      calls.pending.push([source, before.toISOString(), limit]);
      return Promise.resolve(options.pending?.[source] ?? []);
    },
    sliceNdjson(source, s) {
      const n = options.rows?.(source, s) ?? 2;
      const lines = Array.from(
        { length: n },
        (_, i) => JSON.stringify({ source, i, at: s.slice_start }),
      );
      return Promise.resolve({ row_count: n, ndjson: lines.join("\n") });
    },
    logArchive(entry) {
      calls.events.push(`log ${entry.source} ${entry.slice_start}`);
      calls.logs.push(entry);
      return Promise.resolve();
    },
  };
  const store: ArchiveStore = {
    upload(path, bytes) {
      calls.events.push(`upload ${path}`);
      if (options.failUpload?.(path)) return Promise.reject(new Error("storage 503"));
      calls.uploads.push({ path, bytes });
      return Promise.resolve();
    },
  };
  return { db, store, calls };
}

Deno.test("objectPath names the object by source and UTC slice start", () => {
  assertEquals(objectPath("rbn", "2026-10-11T14:10:00+00:00"), "rbn/2026/10/11/1410.ndjson.gz");
  assertEquals(objectPath("pota", "2026-01-02T03:00:00.000Z"), "pota/2026/01/02/0300.ndjson.gz");
});

Deno.test("gzip round-trips text", async () => {
  assertEquals(await gunzip(await gzip("a\nb\n")), "a\nb\n");
});

Deno.test("runArchive asks every source for slices that ended two hours ago, POTA first", async () => {
  const { db, store, calls } = fakes();
  await runArchive(db, store, NOW);
  const cutoff = new Date(NOW.getTime() - LAG_MS).toISOString();
  assertEquals(calls.pending.map(([s, b]) => [s, b]), [["pota", cutoff], ["sotawatch", cutoff], [
    "rbn",
    cutoff,
  ]]);
});

Deno.test("runArchive uploads a gzipped slice, then logs it with its count and size", async () => {
  const s = slice("2026-10-11T14:10:00Z", 10);
  const { db, store, calls } = fakes({ pending: { rbn: [s] }, rows: () => 3 });
  const summary = await runArchive(db, store, NOW);
  assertEquals(calls.events, ["upload rbn/2026/10/11/1410.ndjson.gz", `log rbn ${s.slice_start}`]);
  const text = await gunzip(calls.uploads[0]!.bytes);
  assertEquals(text.split("\n").filter((l) => l !== "").length, 3);
  assertEquals(text.endsWith("\n"), true);
  assertEquals(calls.logs[0], {
    source: "rbn",
    ...s,
    row_count: 3,
    bytes: calls.uploads[0]!.bytes.length,
    object_path: "rbn/2026/10/11/1410.ndjson.gz",
  });
  assertEquals([summary.slices, summary.rows, summary.empty, summary.errors], [1, 3, 0, []]);
});

Deno.test("runArchive logs an empty slice without uploading anything", async () => {
  const s = slice("2026-10-11T03:00:00Z", 60);
  const { db, store, calls } = fakes({ pending: { sotawatch: [s] }, rows: () => 0 });
  const summary = await runArchive(db, store, NOW);
  assertEquals(calls.uploads, []);
  assertEquals(calls.logs, [{
    source: "sotawatch",
    ...s,
    row_count: 0,
    bytes: null,
    object_path: null,
  }]);
  assertEquals([summary.slices, summary.empty], [1, 1]);
});

Deno.test("runArchive stops starting new slices at the row budget", async () => {
  const slices = [0, 10, 20].map((m) =>
    slice(`2026-10-11T14:${String(m).padStart(2, "0")}:00Z`, 10)
  );
  const { db, store, calls } = fakes({
    pending: { rbn: slices },
    rows: () => MAX_ROWS_PER_RUN - 1,
  });
  const summary = await runArchive(db, store, NOW);
  // The first slice stays under the budget, the second crosses it, the third is left for the next run.
  assertEquals(calls.uploads.length, 2);
  assertEquals(summary.rows, 2 * (MAX_ROWS_PER_RUN - 1));
});

Deno.test("runArchive: an upload failure leaves the slice unlogged and the other sources continue", async () => {
  const bad = slice("2026-10-11T12:00:00Z", 60);
  const next = slice("2026-10-11T13:00:00Z", 60);
  const good = slice("2026-10-11T14:00:00Z", 10);
  const { db, store, calls } = fakes({
    pending: { pota: [bad, next], rbn: [good] },
    failUpload: (path) => path.startsWith("pota/"),
  });
  const summary = await runArchive(db, store, NOW);
  assertEquals(calls.logs.map((l) => `${l.source} ${l.slice_start}`), [`rbn ${good.slice_start}`]);
  assertEquals(calls.events.filter((e) => e.startsWith("upload pota")).length, 1); // stopped POTA after the failure
  assertEquals(summary.errors.length, 1);
  assertEquals(summary.errors[0]!.includes("storage 503"), true);
});

Deno.test("runArchive records a pending-slices error and moves on", async () => {
  const { db, store } = fakes({ pending: { rbn: [slice("2026-10-11T14:00:00Z", 10)] } });
  const failing: ArchiveDb = {
    ...db,
    pendingSlices: (source, before, limit) =>
      source === "pota"
        ? Promise.reject(new Error("db down"))
        : db.pendingSlices(source, before, limit),
  };
  const summary = await runArchive(failing, store, NOW);
  assertEquals(summary.errors, ["pota: db down"]);
  assertEquals(summary.slices, 1);
});
