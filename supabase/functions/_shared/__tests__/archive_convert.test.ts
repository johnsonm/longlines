import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { parquetReadObjects } from "hyparquet";
import { ARCHIVE_SCHEMAS, encodeParquet, MAX_ROWS_PER_RUN, objectPath } from "../archive.ts";
import {
  convertRequest,
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
const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/archive_ndjson/${name}`, import.meta.url));

function expected(source: Source): { row_count: number; columns: ArchiveColumns } {
  return JSON.parse(fixture(`${source}.columns.json`));
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The old NDJSON key of a slice: `<source>/YYYY/MM/DD/HHMM.ndjson.gz`. */
function ndjsonPath(source: Source, start: string): string {
  const d = new Date(start);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${source}/${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}/` +
    `${two(d.getUTCHours())}${two(d.getUTCMinutes())}.ndjson.gz`;
}

function readParquet(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({ file: bytes.slice().buffer });
}

/** An in-memory bucket. `failOn` makes the named operation throw for paths containing the string. */
function fakeStore(
  objects = new Map<string, Uint8Array>(),
  failOn: Partial<Record<"read" | "upload" | "size" | "remove", string>> = {},
) {
  const ops: string[] = [];
  const check = (op: keyof typeof failOn, path: string) => {
    ops.push(`${op} ${path}`);
    const f = failOn[op];
    if (f !== undefined && path.includes(f)) throw new Error(`${op} failed for ${path}`);
  };
  const store: ArchiveObjectStore = {
    read(path) {
      check("read", path);
      return Promise.resolve(objects.get(path) ?? null);
    },
    upload(path, bytes) {
      check("upload", path);
      objects.set(path, bytes);
      return Promise.resolve();
    },
    size(path) {
      check("size", path);
      return Promise.resolve(objects.get(path)?.length ?? null);
    },
    remove(path) {
      check("remove", path);
      objects.delete(path);
      return Promise.resolve();
    },
  };
  return { store, objects, ops };
}

/** An in-memory archive_log with the two RPCs' semantics. */
function fakeDb(rows: NdjsonSlice[], options: { repointResult?: boolean } = {}) {
  const log = rows.map((r) => ({ ...r, bytes: 0 }));
  const repoints: Array<{ path: string; bytes: number }> = [];
  const db: ConvertDb = {
    ndjsonSlices(after: ConvertCursor | null, limit: number) {
      const key = (s: { slice_start: string; source: string }) =>
        `${new Date(s.slice_start).toISOString()} ${s.source}`;
      return Promise.resolve(
        log.filter((r) => r.object_path.endsWith(".ndjson.gz"))
          .filter((r) => after === null || key(r) > key(after))
          .sort((a, b) => key(a) < key(b) ? -1 : 1)
          .slice(0, limit)
          .map(({ bytes: _bytes, ...r }) => r),
      );
    },
    repointSlice(slice, to) {
      repoints.push({ path: to.object_path, bytes: to.bytes });
      if (options.repointResult === false) return Promise.resolve(false);
      const row = log.find((r) =>
        r.source === slice.source && r.slice_start === slice.slice_start &&
        r.object_path === slice.object_path && r.row_count === slice.row_count
      );
      if (!row) return Promise.resolve(false);
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
  Deno.test(`a ${source} NDJSON slice converts to the Parquet the live archive writes`, async () => {
    const { slice, bytes } = await fixtureSlice(source);
    const { store, objects, ops } = fakeStore(new Map([[slice.object_path, bytes]]));
    const { db, log } = fakeDb([slice]);

    const summary = await runConvert(db, store, { after: null, limit: 10 });

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
    assertEquals(ops, [
      `read ${slice.object_path}`,
      `upload ${path}`,
      `size ${path}`,
      `remove ${slice.object_path}`,
    ]);

    const rows = await readParquet(objects.get(path)!);
    assertEquals(rows.length, want.row_count);
    assertEquals(
      Object.keys(rows[0]!),
      ARCHIVE_SCHEMAS[source].map(([name]) => name),
      "the live columns, in file order",
    );
  });
}

Deno.test("converted values keep line order, rounded milliseconds, jsonb text and nulls", async () => {
  const { slice, bytes } = await fixtureSlice("rbn");
  const { store, objects } = fakeStore(new Map([[slice.object_path, bytes]]));
  await runConvert(fakeDb([slice]).db, store, { after: null, limit: 1 });
  const rbn = await readParquet(objects.get(objectPath("rbn", slice.slice_start))!);
  assertEquals(rbn.map((r) => r["callsign"]), ["K1ABC", "JA1XYZ/P", "ÖH2XX"]);
  assertEquals(
    rbn.map((r) => (r["received_at"] as Date).toISOString()),
    ["2026-10-11T14:10:01.001Z", "2026-10-11T14:12:03.123Z", "2026-10-11T14:20:00.000Z"],
  );
  assertEquals(rbn[2]!["band"], null);

  const pota = await fixtureSlice("pota");
  const potaStore = fakeStore(new Map([[pota.slice.object_path, pota.bytes]]));
  await runConvert(fakeDb([pota.slice]).db, potaStore.store, { after: null, limit: 1 });
  const rows = await readParquet(
    potaStore.objects.get(objectPath("pota", pota.slice.slice_start))!,
  );
  assertEquals(rows[0]!["comment"], 'QRP ,"raw_payload":{} test');
  assertEquals(
    typeof rows[0]!["raw_payload"] === "string"
      ? rows[0]!["raw_payload"]
      : JSON.stringify(rows[0]!["raw_payload"]),
    expected("pota").columns["raw_payload"]![0],
  );
  assertEquals([rows[1]!["spotter"], rows[1]!["wwff_reference"]], [null, null]);
});

Deno.test("ndjsonColumns maps to_json lines to archive_columns' arrays", () => {
  for (const source of FIXTURE_SOURCES) {
    const { rowCount, columns } = ndjsonColumns(source, fixture(`${source}.ndjson`));
    const want = expected(source);
    assertEquals(rowCount, want.row_count, source);
    assertEquals(columns, want.columns, source);
  }
  assertEquals(ndjsonColumns("rbn", "\n").rowCount, 0);
});

Deno.test("ndjsonColumns refuses lines it cannot map", () => {
  const line = fixture("aprs.ndjson").split("\n")[0]!;
  const row = JSON.parse(line);
  const cases: Array<[string, string]> = [
    ["{not json", "line 1"],
    ["[1]", "not a JSON object"],
    [JSON.stringify({ ...row, line_md5: "x" }), "unknown column line_md5"],
    [JSON.stringify({ ...row, igate: undefined }), "missing column igate"],
    [JSON.stringify({ ...row, received_at: 5 }), "received_at is not a timestamp"],
    [JSON.stringify({ ...row, received_at: "yesterday" }), "not a timestamp"],
    [JSON.stringify({ ...row, path: 3 }), "path is not a string"],
  ];
  for (const [text, message] of cases) {
    assertThrows(() => ndjsonColumns("aprs", text), Error, message);
  }
  const spot = JSON.parse(fixture("rbn.ndjson").split("\n")[0]!);
  assertThrows(
    () => ndjsonColumns("rbn", JSON.stringify({ ...spot, snr: 1.5 })),
    Error,
    "snr is not a int32",
  );
  assertThrows(
    () => ndjsonColumns("rbn", JSON.stringify({ ...spot, frequency_khz: "14035" })),
    Error,
    "frequency_khz is not a double",
  );
  // raw_payload must be the line's last top-level value, as to_json writes it.
  const pota = JSON.parse(fixture("pota.ndjson").split("\n")[1]!);
  const { raw_payload, ...rest } = pota;
  assertThrows(
    () => ndjsonColumns("pota", JSON.stringify({ raw_payload, ...rest })),
    Error,
    "could not locate raw_payload",
  );
  assertEquals(
    ndjsonColumns("pota", JSON.stringify({ ...rest, raw_payload: null })).columns["raw_payload"],
    [null],
  );
});

Deno.test("epochMillis rounds microseconds as Postgres does and honours offsets", () => {
  assertEquals(epochMillis("2026-10-11T14:10:01.0005+00:00"), Date.UTC(2026, 9, 11, 14, 10, 1, 1));
  assertEquals(epochMillis("2026-10-11T14:10:01.0004+00:00"), Date.UTC(2026, 9, 11, 14, 10, 1, 0));
  assertEquals(epochMillis("2026-10-11T14:10:01Z"), Date.UTC(2026, 9, 11, 14, 10, 1));
  assertEquals(epochMillis("2026-10-11T19:40:01.5+05:30"), Date.UTC(2026, 9, 11, 14, 10, 1, 500));
  assertEquals(epochMillis("2026-10-11T09:10:01-05"), Date.UTC(2026, 9, 11, 14, 10, 1));
  assertEquals(epochMillis("1883-11-18T12:00:00-04:56:02"), Date.UTC(1883, 10, 18, 16, 56, 2));
  assertThrows(() => epochMillis("2026-13-45T99:00:00+00:00"), Error, "not a timestamp");
});

Deno.test("ndjsonText gunzips stored bytes and passes through text a GET already decoded", async () => {
  assertEquals(await ndjsonText(await gzip("a\nb\n")), "a\nb\n");
  assertEquals(await ndjsonText(new TextEncoder().encode("{}\n")), "{}\n");
  await assertRejects(() => ndjsonText(new Uint8Array([0x1f, 0x8b, 0, 0])));
});

Deno.test("a count mismatch leaves the slice, its log row and the NDJSON object as they were", async () => {
  const { slice, bytes } = await fixtureSlice("rbn");
  const wrong = { ...slice, row_count: slice.row_count + 1 };
  const { store, objects, ops } = fakeStore(new Map([[slice.object_path, bytes]]));
  const { db, log, repoints } = fakeDb([wrong]);
  const summary = await runConvert(db, store, { after: null, limit: 10 });
  assertEquals(summary.converted, 0);
  assertEquals(summary.failed, [{
    source: "rbn",
    slice_start: slice.slice_start,
    error: "row count mismatch: the object has 3, the log 4",
  }]);
  assertEquals(ops, [`read ${slice.object_path}`], "nothing uploaded");
  assertEquals(repoints, []);
  assertEquals(log[0]!.object_path, slice.object_path);
  assertEquals(objects.get(slice.object_path), bytes);
});

Deno.test("nothing is deleted unless the upload reads back and the log row moved", async () => {
  const { slice, bytes } = await fixtureSlice("aprs");
  const parquetPath = objectPath("aprs", slice.slice_start);
  const cases: Array<[string, () => ReturnType<typeof fakeStore>, boolean | undefined, string]> = [
    ["missing object", () => fakeStore(), undefined, "NDJSON object missing"],
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
      () => fakeStore(new Map([[slice.object_path, bytes]])),
      false,
      "the log row changed",
    ],
  ];
  for (const [name, make, repointResult, message] of cases) {
    const bucket = make();
    const { db, log } = fakeDb([slice], { repointResult });
    const summary = await runConvert(db, bucket.store, { after: null, limit: 10 });
    assertEquals(summary.converted, 0, name);
    assertEquals(
      summary.failed[0]?.error.includes(message),
      true,
      `${name}: ${summary.failed[0]?.error}`,
    );
    assertEquals(bucket.ops.some((op) => op.startsWith("remove")), false, name);
    assertEquals(log[0]!.object_path, slice.object_path, name);
  }

  // An upload that reads back short is not trusted.
  const short = fakeStore(new Map([[slice.object_path, bytes]]));
  const store: ArchiveObjectStore = {
    ...short.store,
    size: () => Promise.resolve(1),
  };
  const summary = await runConvert(fakeDb([slice]).db, store, { after: null, limit: 1 });
  assertEquals(
    summary.failed[0]?.error,
    `uploaded ${parquetPath} reads back as 1, not ${short.objects.get(parquetPath)!.length}`,
  );
  assertEquals(short.objects.has(slice.object_path), true);
});

Deno.test("refuses a log row that is not NDJSON or an NDJSON object without rows", async () => {
  const { slice } = await fixtureSlice("rbn");
  const empty = { ...slice, row_count: 0 };
  const { store } = fakeStore(new Map([[slice.object_path, await gzip("")]]));
  let summary = await runConvert(fakeDb([empty]).db, store, { after: null, limit: 1 });
  assertEquals(summary.failed[0]?.error, "the NDJSON object has no rows");
  const db: ConvertDb = {
    ndjsonSlices: () => Promise.resolve([{ ...slice, object_path: "rbn/x.parquet" }]),
    repointSlice: () => Promise.resolve(true),
  };
  summary = await runConvert(db, store, { after: null, limit: 1 });
  assertEquals(summary.failed[0]?.error, "not an NDJSON object: rbn/x.parquet");
});

Deno.test("a failed NDJSON delete still counts the slice converted and names the leftover", async () => {
  const { slice, bytes } = await fixtureSlice("sotawatch");
  const { store } = fakeStore(new Map([[slice.object_path, bytes]]), { remove: "ndjson" });
  const { db, log } = fakeDb([slice]);
  const summary = await runConvert(db, store, { after: null, limit: 1 });
  assertEquals([summary.converted, summary.failed, summary.undeleted], [1, [], [
    slice.object_path,
  ]]);
  assertEquals(log[0]!.object_path, objectPath("sotawatch", slice.slice_start));
});

Deno.test("runs resume: oldest first, a rerun skips converted slices, a cursor steps past failures", async () => {
  const objects = new Map<string, Uint8Array>();
  const slices: NdjsonSlice[] = [];
  const { slice: base, bytes } = await fixtureSlice("rbn");
  // Five RBN slices ten minutes apart, listed out of order; the second one is corrupt.
  for (const [i, minute] of [[0, 40], [1, 10], [2, 30], [3, 0], [4, 20]] as const) {
    const start = `2026-10-11T13:${String(minute).padStart(2, "0")}:00+00:00`;
    const s = {
      ...base,
      slice_start: start,
      slice_end: start,
      object_path: ndjsonPath("rbn", start),
    };
    slices.push(s);
    objects.set(s.object_path, i === 1 ? await gzip("{broken\n{}\n{}\n") : bytes);
  }
  const { store } = fakeStore(objects);
  const { db, log } = fakeDb(slices);

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
});

Deno.test("runConvert stops starting slices past the row budget", async () => {
  const half = MAX_ROWS_PER_RUN / 2 + 1;
  const slices: NdjsonSlice[] = ["13:00", "13:10", "13:20"].map((hm) => ({
    source: "rbn",
    slice_start: `2026-10-11T${hm}:00+00:00`,
    slice_end: `2026-10-11T${hm}:00+00:00`,
    row_count: half,
    object_path: ndjsonPath("rbn", `2026-10-11T${hm}:00Z`),
  }));
  const { store, ops } = fakeStore();
  const summary = await runConvert(fakeDb(slices).db, store, { after: null, limit: 10 });
  assertEquals(ops.filter((op) => op.startsWith("read")).length, 1);
  assertEquals(summary.next, { slice_start: "2026-10-11T13:00:00+00:00", source: "rbn" });
});

Deno.test("convertRequest reads limit and cursor, with defaults", () => {
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
    ]
  ) {
    assertThrows(() => convertRequest(bad), Error, undefined, JSON.stringify(bad));
  }
});
