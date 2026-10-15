import { assertEquals, assertThrows } from "@std/assert";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import {
  ARCHIVE_ORDER,
  ARCHIVE_SCHEMAS,
  archiveSources,
  encodeParquet,
  LAG_MS,
  MAX_ROWS_PER_RUN,
  objectPath,
  runArchive,
} from "../archive.ts";
import type {
  ArchiveColumns,
  ArchiveDb,
  ArchiveLogEntry,
  ArchiveSlice,
  ArchiveStore,
  Source,
} from "../types.ts";

const NOW = new Date("2026-10-11T20:05:00Z");

function readParquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({ file: bytes.slice().buffer });
}

/** n rows of a source's columns: timestamps one second apart from `at`, numbers from i, strings tagged with i. */
function columnsFor(source: Source, n: number, at = "2026-10-11T14:10:00Z"): ArchiveColumns {
  const t0 = new Date(at).getTime();
  return Object.fromEntries(ARCHIVE_SCHEMAS[source].map(([name, type]) => [
    name,
    Array.from({ length: n }, (_, i) => {
      switch (type) {
        case "timestamp":
          return t0 + i * 1000;
        case "double":
          return 14000.5 + i;
        case "int32":
          return i;
        case "json":
          return JSON.stringify({ i });
        case "string":
          return `${name}-${i}`;
      }
    }),
  ]));
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
    sliceColumns(source, s) {
      const n = options.rows?.(source, s) ?? 2;
      return Promise.resolve({
        row_count: n,
        columns: n === 0 ? null : columnsFor(source, n, s.slice_start),
      });
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

Deno.test("objectPath puts the object in hive-style UTC day folders under its source", () => {
  assertEquals(
    objectPath("rbn", "2026-10-11T14:10:00+00:00"),
    "rbn/year=2026/month=10/day=11/1410.parquet",
  );
  assertEquals(
    objectPath("pota", "2026-01-02T03:00:00.000Z"),
    "pota/year=2026/month=01/day=02/0300.parquet",
  );
  // A slice start late on the 14th in New York is already the 15th in UTC.
  assertEquals(
    objectPath("dxcluster", "2026-10-14T23:00:00-04:00"),
    "dxcluster/year=2026/month=10/day=15/0300.parquet",
  );
});

Deno.test("objectPath names APRS-IS slices by their five-minute start", () => {
  assertEquals(
    objectPath("aprs", "2026-10-14T15:55:00+00:00"),
    "aprs/year=2026/month=10/day=14/1555.parquet",
  );
});

Deno.test("ARCHIVE_SCHEMAS matches the columns archive_columns returns", () => {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../migrations/20261015000400_wwff_source.sql",
      import.meta.url,
    ),
  );
  // Each branch's json_build_object, in order: rbn, aprs, then the raw_spots sources.
  const branches = [...sql.matchAll(/json_build_object\(([\s\S]*?)\) end/g)].map((m) =>
    [...m[1]!.matchAll(/^\s*'(\w+)', json_agg/gm)].map((c) => c[1])
  );
  const names = (source: Source) => ARCHIVE_SCHEMAS[source].map(([name]) => name);
  assertEquals(branches, [names("rbn"), names("aprs"), names("pota")]);
  assertEquals(names("sotawatch"), names("pota"));
  assertEquals(names("dxcluster"), names("pota"));
  assertEquals(names("wwff"), names("pota"));
});

Deno.test("encodeParquet round-trips every source's columns in row order", async () => {
  for (const source of ["rbn", "aprs", "pota", "sotawatch", "dxcluster", "wwff"] as const) {
    const columns = columnsFor(source, 3);
    const rows = await readParquet(encodeParquet(source, columns, 3));
    assertEquals(rows.length, 3, source);
    assertEquals(Object.keys(rows[0]!), ARCHIVE_SCHEMAS[source].map(([name]) => name), source);
    for (const [name, type] of ARCHIVE_SCHEMAS[source]) {
      const expected = type === "timestamp"
        ? columns[name]!.map((ms) => new Date(ms as number))
        : columns[name];
      assertEquals(rows.map((r) => r[name]), expected, `${source}.${name}`);
    }
  }
});

Deno.test("encodeParquet writes UTC millisecond timestamps, typed numbers and nulls", async () => {
  const columns = columnsFor("rbn", 2);
  columns["band"] = [null, "20m"];
  columns["snr"] = [-3, null];
  const bytes = encodeParquet("rbn", columns, 2);
  const rows = await readParquet(bytes);
  assertEquals(rows.map((r) => r["band"]), [null, "20m"]);
  assertEquals(rows.map((r) => r["snr"]), [-3, null]);
  assertEquals(rows[0]!["spot_time"], new Date("2026-10-11T14:10:00Z"));
  const schema = parquetMetadata(bytes.slice().buffer).schema;
  const element = (name: string) => schema.find((e) => e.name === name);
  assertEquals(element("spot_time")?.logical_type, {
    type: "TIMESTAMP",
    isAdjustedToUTC: true,
    unit: "MILLIS",
  });
  assertEquals(element("frequency_khz")?.type, "DOUBLE");
  assertEquals(element("snr")?.type, "INT32");
});

Deno.test("encodeParquet keeps raw_payload as JSON text", async () => {
  const columns = columnsFor("pota", 1);
  columns["raw_payload"] = ['{"spotId":1,"activator":"K1ABC"}'];
  const bytes = encodeParquet("pota", columns, 1);
  const schema = parquetMetadata(bytes.slice().buffer).schema;
  assertEquals(schema.find((e) => e.name === "raw_payload")?.converted_type, "JSON");
  const [row] = await readParquet(bytes);
  assertEquals(row!["raw_payload"], '{"spotId":1,"activator":"K1ABC"}');
});

Deno.test("encodeParquet refuses a missing or short column", () => {
  const short = columnsFor("aprs", 2);
  short["igate"] = ["x"];
  assertThrows(() => encodeParquet("aprs", short, 2), Error, "column igate: expected 2 values");
  const missing = columnsFor("aprs", 2);
  delete missing["line"];
  assertThrows(() => encodeParquet("aprs", missing, 2), Error, "column line");
});

Deno.test("archiveSources defaults to every source but APRS-IS and takes a list from the body", () => {
  assertEquals(archiveSources(undefined), ARCHIVE_ORDER);
  assertEquals(archiveSources(null), ARCHIVE_ORDER);
  assertEquals(archiveSources({}), ARCHIVE_ORDER);
  assertEquals(ARCHIVE_ORDER.includes("aprs"), false);
  assertEquals(archiveSources({ sources: ["aprs"] }), ["aprs"]);
  assertEquals(archiveSources({ sources: ["rbn", "pota"] }), ["rbn", "pota"]);
  assertThrows(() => archiveSources({ sources: [] }), Error, "non-empty");
  assertThrows(() => archiveSources({ sources: "aprs" }), Error, "non-empty");
  assertThrows(() => archiveSources({ sources: ["aprs", "pskreporter"] }), Error, "pskreporter");
  assertThrows(() => archiveSources([]), Error, "JSON object");
  assertThrows(() => archiveSources("aprs"), Error, "JSON object");
});

Deno.test("runArchive takes only the sources it is given", async () => {
  const start = "2026-10-11T17:00:00Z";
  const { db, store, calls } = fakes({ pending: { aprs: [slice(start, 5)] } });
  const summary = await runArchive(db, store, NOW, ["aprs"]);
  assertEquals(calls.pending.map(([s]) => s), ["aprs"]);
  assertEquals(calls.uploads.map((u) => u.path), ["aprs/year=2026/month=10/day=11/1700.parquet"]);
  assertEquals([summary.slices, summary.rows], [1, 2]);
});

Deno.test("runArchive asks every source for slices that ended two hours ago, POTA first", async () => {
  const { db, store, calls } = fakes();
  await runArchive(db, store, NOW);
  const cutoff = new Date(NOW.getTime() - LAG_MS).toISOString();
  assertEquals(calls.pending.map(([s, b]) => [s, b]), [
    ["pota", cutoff],
    ["sotawatch", cutoff],
    ["dxcluster", cutoff],
    ["wwff", cutoff],
    ["rbn", cutoff],
  ]);
});

Deno.test("runArchive uploads a slice as Parquet, then logs it with its count and size", async () => {
  const s = slice("2026-10-11T14:10:00Z", 10);
  const { db, store, calls } = fakes({ pending: { rbn: [s] }, rows: () => 3 });
  const summary = await runArchive(db, store, NOW);
  const path = "rbn/year=2026/month=10/day=11/1410.parquet";
  assertEquals(calls.events, [`upload ${path}`, `log rbn ${s.slice_start}`]);
  const rows = await readParquet(calls.uploads[0]!.bytes);
  assertEquals(rows.map((r) => r["callsign"]), ["callsign-0", "callsign-1", "callsign-2"]);
  assertEquals(calls.logs[0], {
    source: "rbn",
    ...s,
    row_count: 3,
    bytes: calls.uploads[0]!.bytes.length,
    object_path: path,
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

Deno.test("runArchive: a slice with rows but no columns is an error, not an empty slice", async () => {
  const s = slice("2026-10-11T14:00:00Z", 60);
  const { db, store, calls } = fakes({ pending: { pota: [s] } });
  const broken: ArchiveDb = {
    ...db,
    sliceColumns: () => Promise.resolve({ row_count: 2, columns: null }),
  };
  const summary = await runArchive(broken, store, NOW);
  assertEquals([calls.uploads, calls.logs], [[], []]);
  assertEquals(summary.errors.length, 1);
  assertEquals(summary.errors[0]!.includes("expected 2 values"), true);
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
