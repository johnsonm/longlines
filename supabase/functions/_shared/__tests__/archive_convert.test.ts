import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { parquetReadObjects } from "hyparquet";
import { ValidationError } from "../errors.ts";
import { ARCHIVE_SCHEMAS, encodeParquet, MAX_ROWS_PER_RUN, objectPath } from "../archive.ts";
import {
  convertRequest,
  type ConvertSummary,
  DEFAULT_SLICES_PER_RUN,
  epochMillis,
  MAX_SLICES_PER_RUN,
  ndjsonColumns,
  ndjsonText,
  runConvert,
} from "../archive_convert.ts";
import type {
  ArchiveColumns,
  ArchiveObjectStore,
  ConvertCursor,
  ConvertDb,
  NdjsonSlice,
  Source,
} from "../types.ts";

// Each <source>.ndjson fixture is what the old archive_ndjson wrote for a slice
// (to_json per row, archive order), and <source>.columns.json is what
// archive_columns returns for the same rows, both captured from Postgres in one
// transaction. Converting the first must give the Parquet the live archive
// writes from the second, byte for byte.
const FIXTURE_SOURCES = ["rbn", "aprs", "pota", "sotawatch", "dxcluster"] as const;
const SLICE_STARTS: Record<(typeof FIXTURE_SOURCES)[number], string> = {
  rbn: "2026-10-11T14:10:00+00:00",
  aprs: "2026-10-11T17:55:00+00:00",
  pota: "2026-10-11T14:00:00+00:00",
  sotawatch: "2026-10-11T14:00:00+00:00",
  dxcluster: "2026-10-11T14:00:00+00:00",
};
function fixture(name: string) {
  return Deno.readTextFileSync(new URL(`./fixtures/archive_ndjson/${name}`, import.meta.url));
}

function expected(source: Source): { row_count: number; columns: ArchiveColumns } {
  return JSON.parse(fixture(`${source}.columns.json`));
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** The old NDJSON key of a slice: `<source>/YYYY/MM/DD/HHMM.ndjson.gz`. */
function ndjsonPath(source: Source, start: string): string {
  const d = new Date(start);
  return `${source}/${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/` +
    `${two(d.getUTCHours())}${two(d.getUTCMinutes())}.ndjson.gz`;
}

function readParquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({ file: bytes.slice().buffer });
}

/** An in-memory bucket. `failOn` makes the named operation throw for paths containing the string. */
function fakeStore(
  objects: Map<string, Uint8Array>,
  failOn: Partial<Record<"read" | "upload" | "size" | "remove", string>>,
) {
  const ops: string[] = [];
  function check(op: keyof typeof failOn, path: string) {
    ops.push(`${op} ${path}`);
    const f = failOn[op];
    if (f !== undefined && path.includes(f)) {
      throw new Error(`${op} failed for ${path}`);
    }
  }
  const store: ArchiveObjectStore = {
    read(path) {
      check("read", path);
      const found = objects.get(path);
      if (found === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve(found);
    },
    upload(path, bytes) {
      check("upload", path);
      objects.set(path, bytes);
      return Promise.resolve();
    },
    size(path) {
      check("size", path);
      const found = objects.get(path);
      if (found === undefined) {
        return Promise.resolve(null);
      }
      return Promise.resolve(found.length);
    },
    remove(path) {
      check("remove", path);
      objects.delete(path);
      return Promise.resolve();
    },
  };
  return { store, objects, ops };
}

/** The listing's sort key: (slice_start, source). */
function cursorKey(s: { slice_start: string; source: string }): string {
  return `${new Date(s.slice_start).toISOString()} ${s.source}`;
}

function byCursorKey(a: NdjsonSlice, b: NdjsonSlice): number {
  const left = cursorKey(a);
  const right = cursorKey(b);
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** A log row as ndjsonSlices lists it, without the log's bytes. */
function listed(r: NdjsonSlice & { bytes: number }): NdjsonSlice {
  return {
    source: r.source,
    slice_start: r.slice_start,
    slice_end: r.slice_end,
    row_count: r.row_count,
    object_path: r.object_path,
  };
}

/** The first failure's error; the test fails when there is none. */
function firstError(summary: ConvertSummary, msg: string | undefined): string {
  const failure = summary.failed[0];
  assertExists(failure, msg);
  return failure.error;
}

/** An in-memory archive_log with the two RPCs' semantics. */
function fakeDb(rows: NdjsonSlice[], options: { repointResult?: boolean }) {
  const log = rows.map((r) => Object.assign({}, r, { bytes: 0 }));
  const repoints: Array<{ path: string; bytes: number }> = [];
  const db: ConvertDb = {
    ndjsonSlices(after: ConvertCursor | null, limit: number) {
      return Promise.resolve(
        log.filter((r) => r.object_path.endsWith(".ndjson.gz"))
          .filter((r) => after === null || cursorKey(r) > cursorKey(after))
          .sort(byCursorKey)
          .slice(0, limit)
          .map(listed),
      );
    },
    repointSlice(slice, to) {
      repoints.push({ path: to.object_path, bytes: to.bytes });
      if (options.repointResult === false) {
        return Promise.resolve(false);
      }
      const row = log.find((r) =>
        r.source === slice.source && r.slice_start === slice.slice_start &&
        r.object_path === slice.object_path && r.row_count === slice.row_count
      );
      if (!row) {
        return Promise.resolve(false);
      }
      row.object_path = to.object_path;
      row.bytes = to.bytes;
      return Promise.resolve(true);
    },
  };
  return { db, log, repoints };
}

async function fixtureSlice(source: (typeof FIXTURE_SOURCES)[number]) {
  const start = SLICE_STARTS[source];
  const slice: NdjsonSlice = {
    source,
    slice_start: start,
    slice_end: start,
    row_count: expected(source).row_count,
    object_path: ndjsonPath(source, start),
  };
  return { slice, bytes: await gzip(`${fixture(`${source}.ndjson`).trimEnd()}\n`) };
}

for (const source of FIXTURE_SOURCES) {
  Deno.test(
    `a ${source} NDJSON slice converts to the Parquet the live archive writes`,
    async function (): Promise<void> {
      const fx = await fixtureSlice(source);
      const slice = fx.slice;
      const bucket = fakeStore(new Map([[slice.object_path, fx.bytes]]), {});
      const objects = bucket.objects;
      const fake = fakeDb([slice], {});
      const log = fake.log;

      const summary = await runConvert(fake.db, bucket.store, { after: null, limit: 10 });

      const path = objectPath(source, slice.slice_start);
      const want = expected(source);
      const live = encodeParquet(source, want.columns, want.row_count);
      assertEquals(summary.failed, []);
      assertEquals([summary.converted, summary.rows, summary.bytes], [
        1,
        want.row_count,
        live.length,
      ]);
      assertEquals(objects.get(path), live, "byte for byte what archive_columns would give");
      assertEquals(objects.has(slice.object_path), false, "the NDJSON object is deleted");
      assertEquals(log[0]!.object_path, path);
      assertEquals(log[0]!.bytes, live.length);
      assertEquals(bucket.ops, [
        `read ${slice.object_path}`,
        `upload ${path}`,
        `size ${path}`,
        `remove ${slice.object_path}`,
      ]);

      const rows = await readParquet(objects.get(path)!);
      assertEquals(rows.length, want.row_count);
      assertEquals(
        Object.keys(rows[0]!),
        ARCHIVE_SCHEMAS[source].map((c) => c[0]),
        "the live columns, in file order",
      );
    },
  );
}

Deno.test(
  "converted values keep line order, rounded milliseconds, jsonb text and nulls",
  async function (): Promise<void> {
    const fx = await fixtureSlice("rbn");
    const slice = fx.slice;
    const bucket = fakeStore(new Map([[slice.object_path, fx.bytes]]), {});
    await runConvert(fakeDb([slice], {}).db, bucket.store, { after: null, limit: 1 });
    const rbn = await readParquet(bucket.objects.get(objectPath("rbn", slice.slice_start))!);
    assertEquals(rbn.map((r) => r["callsign"]), ["K1ABC", "JA1XYZ/P", "ÖH2XX"]);
    assertEquals(
      rbn.map((r) => (r["received_at"] as Date).toISOString()),
      ["2026-10-11T14:10:01.001Z", "2026-10-11T14:12:03.123Z", "2026-10-11T14:20:00.000Z"],
    );
    assertEquals(rbn[2]!["band"], null);

    const pota = await fixtureSlice("pota");
    const potaStore = fakeStore(new Map([[pota.slice.object_path, pota.bytes]]), {});
    await runConvert(fakeDb([pota.slice], {}).db, potaStore.store, { after: null, limit: 1 });
    const rows = await readParquet(
      potaStore.objects.get(objectPath("pota", pota.slice.slice_start))!,
    );
    assertEquals(rows[0]!["comment"], 'QRP ,"raw_payload":{} test');
    let rawPayload = rows[0]!["raw_payload"];
    if (typeof rawPayload !== "string") {
      rawPayload = JSON.stringify(rawPayload);
    }
    assertEquals(rawPayload, expected("pota").columns["raw_payload"]![0]);
    assertEquals([rows[1]!["spotter"], rows[1]!["wwff_reference"]], [null, null]);
  },
);

Deno.test("ndjsonColumns maps to_json lines to archive_columns' arrays", function (): void {
  for (const source of FIXTURE_SOURCES) {
    const got = ndjsonColumns(source, fixture(`${source}.ndjson`));
    const want = expected(source);
    assertEquals(got.rowCount, want.row_count, source);
    assertEquals(got.columns, want.columns, source);
  }
  assertEquals(ndjsonColumns("rbn", "\n").rowCount, 0);
});

Deno.test("ndjsonColumns refuses lines it cannot map", function (): void {
  const line = fixture("aprs.ndjson").split("\n")[0]!;
  const row = JSON.parse(line);
  const cases: Array<[string, string]> = [
    ["{not json", "ndjsonColumns: line 1: Expected property name"],
    ["[1]", "ndjsonColumns: line 1: (root): Invalid input: expected object, received array"],
    [
      JSON.stringify(Object.assign({}, row, { line_md5: "x" })),
      'ndjsonColumns: line 1: (root): Unrecognized key: "line_md5"',
    ],
    [
      JSON.stringify(Object.assign({}, row, { igate: undefined })),
      "ndjsonColumns: line 1: igate: missing column",
    ],
    [
      JSON.stringify(Object.assign({}, row, { received_at: 5 })),
      "ndjsonColumns: line 1: received_at: not a timestamp: 5",
    ],
    [
      JSON.stringify(Object.assign({}, row, { received_at: "yesterday" })),
      'ndjsonColumns: line 1: received_at: not a timestamp: "yesterday"',
    ],
    [
      JSON.stringify(Object.assign({}, row, { path: 3 })),
      "ndjsonColumns: line 1: path: not a string: 3",
    ],
  ];
  for (const c of cases) {
    assertThrows(() => ndjsonColumns("aprs", c[0]), ValidationError, c[1]);
  }
  assertThrows(
    () => ndjsonColumns("aprs", `${line}\n${JSON.stringify(Object.assign({}, row, { path: 3 }))}`),
    ValidationError,
    "ndjsonColumns: line 2: path: not a string: 3",
  );
  const spot = JSON.parse(fixture("rbn.ndjson").split("\n")[0]!);
  assertThrows(
    () => ndjsonColumns("rbn", JSON.stringify(Object.assign({}, spot, { snr: 1.5 }))),
    ValidationError,
    "snr: not a int32: 1.5",
  );
  assertThrows(
    () => ndjsonColumns("rbn", JSON.stringify(Object.assign({}, spot, { frequency_khz: "14035" }))),
    ValidationError,
    'frequency_khz: not a double: "14035"',
  );
  // raw_payload must be the line's last top-level value, as to_json writes it.
  const pota = JSON.parse(fixture("pota.ndjson").split("\n")[1]!);
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(pota)) {
    if (key !== "raw_payload") {
      rest[key] = pota[key];
    }
  }
  assertThrows(
    () =>
      ndjsonColumns("pota", JSON.stringify(Object.assign({ raw_payload: pota.raw_payload }, rest))),
    ValidationError,
    "could not locate raw_payload",
  );
  assertEquals(
    ndjsonColumns("pota", JSON.stringify(Object.assign({}, rest, { raw_payload: null })))
      .columns["raw_payload"],
    [null],
  );
  // raw_payload is compared as JSON.parse read it, uncopied, so an own "__proto__" key
  // (which a copying schema would drop) still matches its text.
  const proto = JSON.stringify(rest).slice(0, -1) + ',"raw_payload":{"__proto__":1,"a":2}}';
  assertEquals(ndjsonColumns("pota", proto).columns["raw_payload"], ['{"__proto__":1,"a":2}']);
});

Deno.test(
  "epochMillis rounds microseconds as Postgres does and honours offsets",
  function (): void {
    assertEquals(
      epochMillis("2026-10-11T14:10:01.0005+00:00"),
      Date.UTC(2026, 9, 11, 14, 10, 1, 1),
    );
    assertEquals(
      epochMillis("2026-10-11T14:10:01.0004+00:00"),
      Date.UTC(2026, 9, 11, 14, 10, 1, 0),
    );
    assertEquals(epochMillis("2026-10-11T14:10:01Z"), Date.UTC(2026, 9, 11, 14, 10, 1));
    assertEquals(epochMillis("2026-10-11T19:40:01.5+05:30"), Date.UTC(2026, 9, 11, 14, 10, 1, 500));
    assertEquals(epochMillis("2026-10-11T09:10:01-05"), Date.UTC(2026, 9, 11, 14, 10, 1));
    assertEquals(epochMillis("1883-11-18T12:00:00-04:56:02"), Date.UTC(1883, 10, 18, 16, 56, 2));
    assertThrows(
      () => epochMillis("2026-13-45T99:00:00+00:00"),
      ValidationError,
      'not a timestamp: "2026-13-45T99:00:00+00:00"',
    );
  },
);

Deno.test(
  "ndjsonText gunzips stored bytes and passes through text a GET already decoded",
  async function (): Promise<void> {
    assertEquals(await ndjsonText(await gzip("a\nb\n")), "a\nb\n");
    assertEquals(await ndjsonText(new TextEncoder().encode("{}\n")), "{}\n");
    await assertRejects(() => ndjsonText(new Uint8Array([0x1f, 0x8b, 0, 0])));
  },
);

Deno.test(
  "a count mismatch leaves the slice, its log row and the NDJSON object as they were",
  async function (): Promise<void> {
    const fx = await fixtureSlice("rbn");
    const slice = fx.slice;
    const bytes = fx.bytes;
    const wrong = Object.assign({}, slice, { row_count: slice.row_count + 1 });
    const bucket = fakeStore(new Map([[slice.object_path, bytes]]), {});
    const fake = fakeDb([wrong], {});
    const summary = await runConvert(fake.db, bucket.store, { after: null, limit: 10 });
    assertEquals(summary.converted, 0);
    assertEquals(summary.failed, [{
      source: "rbn",
      slice_start: slice.slice_start,
      error: "row count mismatch: the object has 3, the log 4",
    }]);
    assertEquals(bucket.ops, [`read ${slice.object_path}`], "nothing uploaded");
    assertEquals(fake.repoints, []);
    assertEquals(fake.log[0]!.object_path, slice.object_path);
    assertEquals(bucket.objects.get(slice.object_path), bytes);
  },
);

Deno.test(
  "nothing is deleted unless the upload reads back and the log row moved",
  async function (): Promise<void> {
    const fx = await fixtureSlice("aprs");
    const slice = fx.slice;
    const bytes = fx.bytes;
    const parquetPath = objectPath("aprs", slice.slice_start);
    const cases: Array<[string, () => ReturnType<typeof fakeStore>, boolean | undefined, string]> =
      [
        [
          "missing object",
          () => fakeStore(new Map<string, Uint8Array>(), {}),
          undefined,
          "NDJSON object missing",
        ],
        [
          "upload fails",
          () => fakeStore(new Map([[slice.object_path, bytes]]), { upload: "parquet" }),
          undefined,
          "upload failed",
        ],
        [
          "size check fails",
          () => fakeStore(new Map([[slice.object_path, bytes]]), { size: "parquet" }),
          undefined,
          "size failed",
        ],
        [
          "repoint refused",
          () => fakeStore(new Map([[slice.object_path, bytes]]), {}),
          false,
          "the log row changed",
        ],
      ];
    for (const c of cases) {
      const name = c[0];
      const bucket = c[1]();
      const fake = fakeDb([slice], { repointResult: c[2] });
      const summary = await runConvert(fake.db, bucket.store, { after: null, limit: 10 });
      assertEquals(summary.converted, 0, name);
      const error = firstError(summary, name);
      assertEquals(error.includes(c[3]), true, `${name}: ${error}`);
      assertEquals(bucket.ops.some((op) => op.startsWith("remove")), false, name);
      assertEquals(fake.log[0]!.object_path, slice.object_path, name);
    }

    // An upload that reads back short is not trusted.
    const short = fakeStore(new Map([[slice.object_path, bytes]]), {});
    const store: ArchiveObjectStore = {
      read: short.store.read,
      upload: short.store.upload,
      size: () => Promise.resolve(1),
      remove: short.store.remove,
    };
    const summary = await runConvert(fakeDb([slice], {}).db, store, { after: null, limit: 1 });
    assertEquals(
      firstError(summary, undefined),
      `uploaded ${parquetPath} reads back as 1, not ${short.objects.get(parquetPath)!.length}`,
    );
    assertEquals(short.objects.has(slice.object_path), true);
  },
);

Deno.test(
  "refuses a log row that is not NDJSON or an NDJSON object without rows",
  async function (): Promise<void> {
    const slice = (await fixtureSlice("rbn")).slice;
    const empty = Object.assign({}, slice, { row_count: 0 });
    const store = fakeStore(new Map([[slice.object_path, await gzip("")]]), {}).store;
    let summary = await runConvert(fakeDb([empty], {}).db, store, { after: null, limit: 1 });
    assertEquals(firstError(summary, undefined), "the NDJSON object has no rows");
    const db: ConvertDb = {
      ndjsonSlices: () =>
        Promise.resolve([Object.assign({}, slice, { object_path: "rbn/x.parquet" })]),
      repointSlice: () => Promise.resolve(true),
    };
    summary = await runConvert(db, store, { after: null, limit: 1 });
    assertEquals(firstError(summary, undefined), "not an NDJSON object: rbn/x.parquet");
  },
);

Deno.test(
  "a failed NDJSON delete still counts the slice converted and names the leftover",
  async function (): Promise<void> {
    const fx = await fixtureSlice("sotawatch");
    const slice = fx.slice;
    const store = fakeStore(new Map([[slice.object_path, fx.bytes]]), { remove: "ndjson" }).store;
    const fake = fakeDb([slice], {});
    const summary = await runConvert(fake.db, store, { after: null, limit: 1 });
    assertEquals([summary.converted, summary.failed, summary.undeleted], [1, [], [
      slice.object_path,
    ]]);
    assertEquals(fake.log[0]!.object_path, objectPath("sotawatch", slice.slice_start));
  },
);

Deno.test(
  "runs resume: oldest first, a rerun skips converted slices, a cursor steps past failures",
  async function (): Promise<void> {
    const objects = new Map<string, Uint8Array>();
    const slices: NdjsonSlice[] = [];
    const fx = await fixtureSlice("rbn");
    const base = fx.slice;
    const bytes = fx.bytes;
    // Five RBN slices ten minutes apart, listed out of order; the second one is corrupt.
    for (const pair of [[0, 40], [1, 10], [2, 30], [3, 0], [4, 20]] as const) {
      const i = pair[0];
      const minute = pair[1];
      const start = `2026-10-11T13:${String(minute).padStart(2, "0")}:00+00:00`;
      const s = Object.assign({}, base, {
        slice_start: start,
        slice_end: start,
        object_path: ndjsonPath("rbn", start),
      });
      slices.push(s);
      if (i === 1) {
        objects.set(s.object_path, await gzip("{broken\n{}\n{}\n"));
      } else {
        objects.set(s.object_path, bytes);
      }
    }
    const store = fakeStore(objects, {}).store;
    const fake = fakeDb(slices, {});
    const db = fake.db;
    const log = fake.log;

    const first = await runConvert(db, store, { after: null, limit: 2 });
    assertEquals(first.converted, 1);
    assertEquals(first.failed.map((f) => f.slice_start), ["2026-10-11T13:10:00+00:00"]);
    assertEquals(first.next, { slice_start: "2026-10-11T13:10:00+00:00", source: "rbn" });

    // Without the cursor the failed slice heads the batch again; already converted ones are not listed.
    const again = await runConvert(db, store, { after: null, limit: 2 });
    assertEquals([again.converted, again.failed.length], [1, 1]);

    const rest = await runConvert(db, store, { after: again.next, limit: 10 });
    assertEquals([rest.converted, rest.failed.length, rest.next], [2, 0, null]);
    assertEquals(
      log.filter((r) => r.object_path.endsWith(".ndjson.gz")).map((r) => r.slice_start),
      ["2026-10-11T13:10:00+00:00"],
    );

    // A crash between upload and repoint left a Parquet object: the rerun overwrites it.
    const leftover = log.find((r) => r.object_path.endsWith(".ndjson.gz"))!;
    objects.set(objectPath("rbn", leftover.slice_start), new Uint8Array([9]));
    objects.set(leftover.object_path, bytes);
    const last = await runConvert(db, store, { after: null, limit: 10 });
    assertEquals([last.converted, last.failed.length], [1, 0]);
    assertEquals(objects.get(objectPath("rbn", leftover.slice_start))!.length > 1, true);
  },
);

Deno.test("runConvert stops starting slices past the row budget", async function (): Promise<void> {
  const half = MAX_ROWS_PER_RUN / 2 + 1;
  const slices: NdjsonSlice[] = ["13:00", "13:10", "13:20"].map((hm) => ({
    source: "rbn",
    slice_start: `2026-10-11T${hm}:00+00:00`,
    slice_end: `2026-10-11T${hm}:00+00:00`,
    row_count: half,
    object_path: ndjsonPath("rbn", `2026-10-11T${hm}:00Z`),
  }));
  const bucket = fakeStore(new Map<string, Uint8Array>(), {});
  const summary = await runConvert(fakeDb(slices, {}).db, bucket.store, { after: null, limit: 10 });
  assertEquals(bucket.ops.filter((op) => op.startsWith("read")).length, 1);
  assertEquals(summary.next, { slice_start: "2026-10-11T13:00:00+00:00", source: "rbn" });
});

Deno.test("convertRequest reads limit and cursor, with defaults", function (): void {
  assertEquals(convertRequest(undefined), { after: null, limit: DEFAULT_SLICES_PER_RUN });
  assertEquals(convertRequest({}), { after: null, limit: DEFAULT_SLICES_PER_RUN });
  assertEquals(
    convertRequest({
      limit: 3,
      after: { slice_start: "2026-10-11T13:10:00+00:00", source: "rbn" },
    }),
    { after: { slice_start: "2026-10-11T13:10:00+00:00", source: "rbn" }, limit: 3 },
  );
  assertEquals(convertRequest({ after: null }).after, null);
  for (
    const bad of [
      [],
      "x",
      { limit: 0 },
      { limit: MAX_SLICES_PER_RUN + 1 },
      { limit: 1.5 },
      { after: "2026-10-11" },
      { after: { slice_start: "nope", source: "rbn" } },
      { after: { slice_start: "2026-10-11T13:10:00Z", source: "pskreporter" } },
      { limit: null },
      // The body is ours, and so is the cursor (a summary's `next`): unknown keys are refused.
      { after: { slice_start: "2026-10-11T13:10:00Z", source: "rbn", line: 1 } },
      { lim: 1 },
    ]
  ) {
    assertThrows(() => convertRequest(bad), ValidationError, undefined, JSON.stringify(bad));
  }
  assertThrows(
    () => convertRequest({ limit: 0 }),
    ValidationError,
    'convertRequest: request body: limit: "limit" must be an integer from 1 to 100',
  );
});
