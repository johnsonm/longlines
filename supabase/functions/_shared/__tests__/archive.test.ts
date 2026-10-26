import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { ValidationError } from "../errors.ts";
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

type ColumnType = (typeof ARCHIVE_SCHEMAS)[Source][number][1];

/** Row i of a column, for columnsFor. */
function columnValue(name: string, type: ColumnType, t0: number, i: number) {
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
}

/** n rows of a source's columns: timestamps one second apart from `at`, numbers from i, strings tagged with i. */
function columnsFor(source: Source, n: number, at: string): ArchiveColumns {
  const t0 = new Date(at).getTime();
  const columns: ArchiveColumns = {};
  for (const column of ARCHIVE_SCHEMAS[source]) {
    const values: unknown[] = [];
    for (let i = 0; i < n; i++) {
      values.push(columnValue(column[0], column[1], t0, i));
    }
    columns[column[0]] = values;
  }
  return columns;
}

function columnNames(source: Source): string[] {
  return ARCHIVE_SCHEMAS[source].map((c) => c[0]);
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
  },
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
      let pending: ArchiveSlice[] = [];
      if (options.pending !== undefined) {
        const listed = options.pending[source];
        if (listed !== undefined) {
          pending = listed;
        }
      }
      return Promise.resolve(pending);
    },
    sliceColumns(source, s) {
      let n = 2;
      if (options.rows !== undefined) {
        n = options.rows(source, s);
      }
      let columns: ArchiveColumns | null = null;
      if (n !== 0) {
        columns = columnsFor(source, n, s.slice_start);
      }
      return Promise.resolve({ row_count: n, columns });
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
      if (options.failUpload !== undefined && options.failUpload(path)) {
        return Promise.reject(new Error("storage 503"));
      }
      calls.uploads.push({ path, bytes });
      return Promise.resolve();
    },
  };
  return { db, store, calls };
}

Deno.test(
  "objectPath puts the object in hive-style UTC day folders under its source",
  function (): void {
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
  },
);

Deno.test("objectPath names APRS-IS slices by their five-minute start", function (): void {
  assertEquals(
    objectPath("aprs", "2026-10-14T15:55:00+00:00"),
    "aprs/year=2026/month=10/day=14/1555.parquet",
  );
});

Deno.test("ARCHIVE_SCHEMAS matches the columns archive_columns returns", function (): void {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../migrations/20261015001000_wwff_source.sql",
      import.meta.url,
    ),
  );
  // Each branch's json_build_object, in order: rbn, aprs, then the raw_spots sources.
  const branches = Array.from(sql.matchAll(/json_build_object\(([\s\S]*?)\) end/g)).map((m) =>
    Array.from(m[1]!.matchAll(/^\s*'(\w+)', json_agg/gm)).map((c) => c[1])
  );
  assertEquals(branches, [columnNames("rbn"), columnNames("aprs"), columnNames("pota")]);
  assertEquals(columnNames("sotawatch"), columnNames("pota"));
  assertEquals(columnNames("dxcluster"), columnNames("pota"));
  assertEquals(columnNames("wwff"), columnNames("pota"));
});

Deno.test(
  "encodeParquet round-trips every source's columns in row order",
  async function (): Promise<void> {
    for (const source of ["rbn", "aprs", "pota", "sotawatch", "dxcluster", "wwff"] as const) {
      const columns = columnsFor(source, 3, "2026-10-11T14:10:00Z");
      const rows = await readParquet(encodeParquet(source, columns, 3));
      assertEquals(rows.length, 3, source);
      assertEquals(Object.keys(rows[0]!), columnNames(source), source);
      for (const column of ARCHIVE_SCHEMAS[source]) {
        const name = column[0];
        let expected = columns[name];
        if (column[1] === "timestamp") {
          expected = columns[name]!.map((ms) => new Date(ms as number));
        }
        assertEquals(rows.map((r) => r[name]), expected, `${source}.${name}`);
      }
    }
  },
);

Deno.test(
  "encodeParquet writes UTC millisecond timestamps, typed numbers and nulls",
  async function (): Promise<void> {
    const columns = columnsFor("rbn", 2, "2026-10-11T14:10:00Z");
    columns["band"] = [null, "20m"];
    columns["snr"] = [-3, null];
    const bytes = encodeParquet("rbn", columns, 2);
    const rows = await readParquet(bytes);
    assertEquals(rows.map((r) => r["band"]), [null, "20m"]);
    assertEquals(rows.map((r) => r["snr"]), [-3, null]);
    assertEquals(rows[0]!["spot_time"], new Date("2026-10-11T14:10:00Z"));
    const schema = parquetMetadata(bytes.slice().buffer).schema;
    function element(name: string) {
      const found = schema.find((e) => e.name === name);
      assertExists(found);
      return found;
    }
    assertEquals(element("spot_time").logical_type, {
      type: "TIMESTAMP",
      isAdjustedToUTC: true,
      unit: "MILLIS",
    });
    assertEquals(element("frequency_khz").type, "DOUBLE");
    assertEquals(element("snr").type, "INT32");
  },
);

Deno.test("encodeParquet keeps raw_payload as JSON text", async function (): Promise<void> {
  const columns = columnsFor("pota", 1, "2026-10-11T14:10:00Z");
  columns["raw_payload"] = ['{"spotId":1,"activator":"K1ABC"}'];
  const bytes = encodeParquet("pota", columns, 1);
  const schema = parquetMetadata(bytes.slice().buffer).schema;
  const rawPayload = schema.find((e) => e.name === "raw_payload");
  assertExists(rawPayload);
  assertEquals(rawPayload.converted_type, "JSON");
  const rows = await readParquet(bytes);
  assertEquals(rows[0]!["raw_payload"], '{"spotId":1,"activator":"K1ABC"}');
});

Deno.test("encodeParquet refuses a missing or short column", function (): void {
  const short = columnsFor("aprs", 2, "2026-10-11T14:10:00Z");
  short["igate"] = ["x"];
  assertThrows(
    () => encodeParquet("aprs", short, 2),
    ValidationError,
    "column igate: expected 2 values",
  );
  const missing = columnsFor("aprs", 2, "2026-10-11T14:10:00Z");
  delete missing["line"];
  assertThrows(() => encodeParquet("aprs", missing, 2), ValidationError, "column line");
});

Deno.test("encodeParquet refuses a timestamp that is not integer milliseconds", function (): void {
  const text = columnsFor("aprs", 1, "2026-10-11T14:10:00Z");
  text["received_at"] = ["1760191800000"];
  assertThrows(
    () => encodeParquet("aprs", text, 1),
    ValidationError,
    "encodeParquet: column received_at: 0: Invalid input: expected number, received string",
  );
  const fraction = columnsFor("aprs", 1, "2026-10-11T14:10:00Z");
  fraction["received_at"] = [1.5];
  assertThrows(() => encodeParquet("aprs", fraction, 1), ValidationError, "0: not an integer");
});

Deno.test(
  "archiveSources defaults to every source but APRS-IS and takes a list from the body",
  function (): void {
    assertEquals(archiveSources(undefined), ARCHIVE_ORDER);
    assertEquals(archiveSources(null), ARCHIVE_ORDER);
    assertEquals(archiveSources({}), ARCHIVE_ORDER);
    assertEquals(ARCHIVE_ORDER.includes("aprs"), false);
    assertEquals(archiveSources({ sources: ["aprs"] }), ["aprs"]);
    assertEquals(archiveSources({ sources: ["rbn", "pota"] }), ["rbn", "pota"]);
    assertThrows(() => archiveSources({ sources: [] }), ValidationError, "non-empty");
    assertThrows(() => archiveSources({ sources: "aprs" }), ValidationError, "non-empty");
    assertThrows(
      () => archiveSources({ sources: ["aprs", "pskreporter"] }),
      ValidationError,
      'unknown archive source: "pskreporter"',
    );
    // The body is ours, so a key it does not know is refused.
    assertThrows(
      () => archiveSources({ sources: ["aprs"], source: "rbn" }),
      ValidationError,
      'Unrecognized key: "source"',
    );
    assertThrows(() => archiveSources([]), ValidationError, "expected object");
    assertThrows(() => archiveSources("aprs"), ValidationError, "expected object");
  },
);

Deno.test("runArchive takes only the sources it is given", async function (): Promise<void> {
  const start = "2026-10-11T17:00:00Z";
  const fake = fakes({ pending: { aprs: [slice(start, 5)] } });
  const summary = await runArchive(fake.db, fake.store, NOW, ["aprs"]);
  assertEquals(fake.calls.pending.map((p) => p[0]), ["aprs"]);
  assertEquals(fake.calls.uploads.map((u) => u.path), [
    "aprs/year=2026/month=10/day=11/1700.parquet",
  ]);
  assertEquals([summary.slices, summary.rows], [1, 2]);
});

Deno.test(
  "runArchive asks every source for slices that ended two hours ago, POTA first",
  async function (): Promise<void> {
    const fake = fakes({});
    await runArchive(fake.db, fake.store, NOW, ARCHIVE_ORDER);
    const cutoff = new Date(NOW.getTime() - LAG_MS).toISOString();
    assertEquals(fake.calls.pending.map((p) => [p[0], p[1]]), [
      ["pota", cutoff],
      ["sotawatch", cutoff],
      ["dxcluster", cutoff],
      ["wwff", cutoff],
      ["rbn", cutoff],
    ]);
  },
);

Deno.test(
  "runArchive uploads a slice as Parquet, then logs it with its count and size",
  async function (): Promise<void> {
    const s = slice("2026-10-11T14:10:00Z", 10);
    const fake = fakes({ pending: { rbn: [s] }, rows: () => 3 });
    const summary = await runArchive(fake.db, fake.store, NOW, ARCHIVE_ORDER);
    const path = "rbn/year=2026/month=10/day=11/1410.parquet";
    assertEquals(fake.calls.events, [`upload ${path}`, `log rbn ${s.slice_start}`]);
    const rows = await readParquet(fake.calls.uploads[0]!.bytes);
    assertEquals(rows.map((r) => r["callsign"]), ["callsign-0", "callsign-1", "callsign-2"]);
    assertEquals(fake.calls.logs[0], {
      source: "rbn",
      slice_start: s.slice_start,
      slice_end: s.slice_end,
      row_count: 3,
      bytes: fake.calls.uploads[0]!.bytes.length,
      object_path: path,
    });
    assertEquals([summary.slices, summary.rows, summary.empty, summary.errors], [1, 3, 0, []]);
  },
);

Deno.test(
  "runArchive logs an empty slice without uploading anything",
  async function (): Promise<void> {
    const s = slice("2026-10-11T03:00:00Z", 60);
    const fake = fakes({ pending: { sotawatch: [s] }, rows: () => 0 });
    const summary = await runArchive(fake.db, fake.store, NOW, ARCHIVE_ORDER);
    assertEquals(fake.calls.uploads, []);
    assertEquals(fake.calls.logs, [{
      source: "sotawatch",
      slice_start: s.slice_start,
      slice_end: s.slice_end,
      row_count: 0,
      bytes: null,
      object_path: null,
    }]);
    assertEquals([summary.slices, summary.empty], [1, 1]);
  },
);

Deno.test(
  "runArchive stops starting new slices at the row budget",
  async function (): Promise<void> {
    const slices = [0, 10, 20].map((m) =>
      slice(`2026-10-11T14:${String(m).padStart(2, "0")}:00Z`, 10)
    );
    const fake = fakes({
      pending: { rbn: slices },
      rows: () => MAX_ROWS_PER_RUN - 1,
    });
    const summary = await runArchive(fake.db, fake.store, NOW, ARCHIVE_ORDER);
    // The first slice stays under the budget, the second crosses it, the third is left for the next run.
    assertEquals(fake.calls.uploads.length, 2);
    assertEquals(summary.rows, 2 * (MAX_ROWS_PER_RUN - 1));
  },
);

Deno.test(
  "runArchive: an upload failure leaves the slice unlogged and the other sources continue",
  async function (): Promise<void> {
    const bad = slice("2026-10-11T12:00:00Z", 60);
    const next = slice("2026-10-11T13:00:00Z", 60);
    const good = slice("2026-10-11T14:00:00Z", 10);
    const fake = fakes({
      pending: { pota: [bad, next], rbn: [good] },
      failUpload: (path) => path.startsWith("pota/"),
    });
    const summary = await runArchive(fake.db, fake.store, NOW, ARCHIVE_ORDER);
    assertEquals(fake.calls.logs.map((l) => `${l.source} ${l.slice_start}`), [
      `rbn ${good.slice_start}`,
    ]);
    assertEquals(fake.calls.events.filter((e) => e.startsWith("upload pota")).length, 1); // stopped POTA after the failure
    assertEquals(summary.errors.length, 1);
    assertEquals(summary.errors[0]!.includes("storage 503"), true);
  },
);

Deno.test(
  "runArchive: a slice with rows but no columns is an error, not an empty slice",
  async function (): Promise<void> {
    const s = slice("2026-10-11T14:00:00Z", 60);
    const fake = fakes({ pending: { pota: [s] } });
    const broken: ArchiveDb = {
      pendingSlices: fake.db.pendingSlices,
      sliceColumns: () => Promise.resolve({ row_count: 2, columns: null }),
      logArchive: fake.db.logArchive,
    };
    const summary = await runArchive(broken, fake.store, NOW, ARCHIVE_ORDER);
    assertEquals([fake.calls.uploads, fake.calls.logs], [[], []]);
    assertEquals(summary.errors.length, 1);
    assertEquals(summary.errors[0]!.includes("expected 2 values"), true);
  },
);

Deno.test(
  "runArchive records a pending-slices error and moves on",
  async function (): Promise<void> {
    const fake = fakes({ pending: { rbn: [slice("2026-10-11T14:00:00Z", 10)] } });
    const failing: ArchiveDb = {
      pendingSlices(source, before, limit) {
        if (source === "pota") {
          return Promise.reject(new Error("db down"));
        }
        return fake.db.pendingSlices(source, before, limit);
      },
      sliceColumns: fake.db.sliceColumns,
      logArchive: fake.db.logArchive,
    };
    const summary = await runArchive(failing, fake.store, NOW, ARCHIVE_ORDER);
    assertEquals(summary.errors, ["pota: db down"]);
    assertEquals(summary.slices, 1);
  },
);
