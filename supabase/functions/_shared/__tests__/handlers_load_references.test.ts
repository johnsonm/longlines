import { assertEquals } from "@std/assert";
import { createReferenceDb } from "../db.ts";
import { handleLoadReferences, parseLoadReferencesRequest } from "../handlers/load_references.ts";
import {
  referenceAbandonReplySchema,
  referenceBeginReplySchema,
  type ReferenceCatalogRow,
  referenceFinishReplySchema,
  referenceRowsReplySchema,
  referenceStatusReplySchema,
} from "../reference_catalog.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const SECRET = "relay-secret";

function post(body: unknown, secret: string | null, method: string): Request {
  const init: RequestInit = { method, headers: {} };
  if (secret !== null) {
    init.headers = { "x-relay-secret": secret };
  }
  if (method === "POST") {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }
  return new Request("http://x/load-references", init);
}

/** A POST whose body stream fails partway, for the read-failure paths. */
function brokenPost(secret: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(new Error("connection reset"));
    },
  });
  return new Request("http://x/", { method: "POST", headers: { "x-relay-secret": secret }, body });
}

function setup(rpc: FakeSupabaseOptions["rpc"]) {
  const fake = fakeSupabase({ rpc });
  const client = fake.client;
  const deps = { secret: SECRET, db: () => createReferenceDb(client) };
  return { deps, calls: fake.calls };
}

// Rejects with whatever it is given, so a test can reject with a non-Error.
async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

const ROW: ReferenceCatalogRow = {
  reference: "W4C/CM-001",
  name: "Mount Mitchell",
  active: true,
  location: null,
  region: "USA - Carolinas, NC-Central Mountains",
  country: null,
  dxcc: null,
  latitude: 35.7648,
  longitude: -82.2652,
  grid: "EM85us",
  altitude_m: 2037,
  points: 10,
  valid_from: "2011-02-01",
  valid_to: "2099-12-31",
};

// reference_load_status' jsonb, as 20261026000100 builds it.
const STATUS = {
  pota: {
    applied: {
      version: "Mon, 19 Oct 2026 07:15:20 GMT",
      started_at: "2026-10-19T08:00:00+00:00",
      applied_at: "2026-10-19T08:55:00+00:00",
      rows: 99122,
    },
    newest: {
      id: 3,
      version: "Mon, 19 Oct 2026 07:15:20 GMT",
      state: "applied",
      rows: 99122,
      started_at: "2026-10-19T08:00:00+00:00",
      finished_at: "2026-10-19T08:03:00+00:00",
    },
  },
  sota: { applied: null, newest: null },
  wwff: { applied: null, newest: null },
};

Deno.test(
  "handleLoadReferences refuses a missing or wrong relay secret",
  async function (): Promise<void> {
    const s = setup({});
    for (const secret of [null, "wrong"]) {
      assertEquals(
        (await handleLoadReferences(post({ action: "status" }, secret, "POST"), s.deps)).status,
        401,
      );
    }
    const unset = await handleLoadReferences(post({ action: "status" }, SECRET, "POST"), {
      secret: undefined,
      db: s.deps.db,
    });
    assertEquals(unset.status, 500);
    assertEquals(s.calls.rpc, []);
  },
);

Deno.test("handleLoadReferences takes POST with a JSON body only", async function (): Promise<
  void
> {
  const deps = setup({}).deps;
  assertEquals((await handleLoadReferences(post(null, SECRET, "GET"), deps)).status, 405);
  const bad = await handleLoadReferences(post("not json", SECRET, "POST"), deps);
  assertEquals([bad.status, (await bad.json()).error], [400, "request body is not JSON"]);
  const invalid = await handleLoadReferences(post({ action: "drop" }, SECRET, "POST"), deps);
  assertEquals(invalid.status, 400);
});

Deno.test("handleLoadReferences maps each action to its RPC", async function (): Promise<void> {
  const s = setup({
    reference_load_status: { data: STATUS },
    begin_reference_load: { data: 8 },
    stage_reference_rows: { data: 2 },
    finish_reference_load: { data: "refused" },
    abandon_reference_load: { data: null },
  });
  const answers: unknown[] = [];
  for (
    const body of [
      { action: "status" },
      { action: "begin", program: "sota", version: "Mon, 26 Oct 2026 03:39:12 GMT" },
      { action: "rows", load: 8, rows: [ROW, ROW] },
      { action: "finish", load: 8, rows: 2 },
      { action: "abandon", load: 8, error: "x".repeat(1200) },
    ]
  ) {
    const res = await handleLoadReferences(post(body, SECRET, "POST"), s.deps);
    assertEquals(res.status, 200);
    answers.push(await res.json());
  }
  assertEquals(answers, [
    { status: STATUS },
    { load: 8 },
    { staged: 2 },
    { state: "refused" },
    { ok: true },
  ]);
  // Each reply is what the relay reads it as.
  const schemas = [
    referenceStatusReplySchema,
    referenceBeginReplySchema,
    referenceRowsReplySchema,
    referenceFinishReplySchema,
    referenceAbandonReplySchema,
  ];
  schemas.forEach((schema, i) => assertEquals(schema.safeParse(answers[i]).success, true, `${i}`));
  assertEquals(s.calls.rpc, [
    { fn: "reference_load_status", args: undefined },
    {
      fn: "begin_reference_load",
      args: { p_program: "sota", p_version: "Mon, 26 Oct 2026 03:39:12 GMT" },
    },
    { fn: "stage_reference_rows", args: { p_load: 8, p_rows: [ROW, ROW] } },
    { fn: "finish_reference_load", args: { p_load: 8, p_rows: 2 } },
    { fn: "abandon_reference_load", args: { p_load: 8, p_error: "x".repeat(1000) } },
  ]);
});

Deno.test(
  "handleLoadReferences answers 500 with the database error or a result of the wrong shape",
  async function (): Promise<void> {
    const deps = setup({
      stage_reference_rows: { error: { message: "stage_reference_rows: load 1 is not staging" } },
      finish_reference_load: { data: "done" },
      reference_load_status: { data: { pota: STATUS.pota } },
    }).deps;
    const stage = await handleLoadReferences(
      post({ action: "rows", load: 1, rows: [ROW] }, SECRET, "POST"),
      deps,
    );
    assertEquals([stage.status, (await stage.json()).error], [
      500,
      "stage_reference_rows failed: stage_reference_rows: load 1 is not staging",
    ]);
    const finish = await handleLoadReferences(
      post({ action: "finish", load: 1, rows: 1 }, SECRET, "POST"),
      deps,
    );
    assertEquals(finish.status, 500);
    assertEquals(
      (await finish.json()).error.startsWith("finishLoad: finish_reference_load result"),
      true,
    );
    const status = await handleLoadReferences(post({ action: "status" }, SECRET, "POST"), deps);
    assertEquals(status.status, 500);
    assertEquals(
      (await status.json()).error.startsWith("loadStatus: reference_load_status result"),
      true,
    );
  },
);

Deno.test("handleLoadReferences reports a thrown non-Error as text", async function (): Promise<
  void
> {
  const res = await handleLoadReferences(post({ action: "status" }, SECRET, "POST"), {
    secret: SECRET,
    db: () => ({
      loadStatus: () => rejectWith("socket closed"),
      beginLoad: () => Promise.resolve(0),
      stageRows: () => Promise.resolve(0),
      finishLoad: () => Promise.resolve("finished"),
      abandonLoad: () => Promise.resolve(),
    }),
  });
  assertEquals([res.status, (await res.json()).error], [500, "socket closed"]);
});

Deno.test("parseLoadReferencesRequest rejects malformed requests", function (): void {
  function withRow(key: string, value: unknown): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const k of Object.keys(ROW)) {
      row[k] = ROW[k as keyof ReferenceCatalogRow];
    }
    row[key] = value;
    return row;
  }
  for (
    const body of [
      null,
      [],
      { action: "begin", program: "pota" },
      { action: "begin", program: "iota", version: "v" },
      { action: "begin", program: "pota", version: " " },
      { action: "begin", program: "pota", version: "x".repeat(101) },
      { action: "rows", load: -1, rows: [ROW] },
      { action: "rows", load: 1, rows: [] },
      { action: "rows", load: 1, rows: Array(5_001).fill(ROW) },
      { action: "rows", load: 1, rows: [ROW, "US-0001"] },
      { action: "finish", load: 1 },
      { action: "finish", load: 1, rows: 1.5 },
      { action: "finish", load: "1", rows: 1 },
      { action: "abandon", load: 1 },
      { action: "abandon", load: -1, error: "x" },
      // Strict: the relay sends exactly these keys, so any other is refused.
      { action: "status", extra: 1 },
      { action: "finish", load: 1, rows: 1, counts: {} },
      { action: "rows", load: 1, rows: [withRow("extra", 1)] },
      { action: "rows", load: 1, rows: [withRow("reference", "")] },
      { action: "rows", load: 1, rows: [withRow("active", "1")] },
      { action: "rows", load: 1, rows: [withRow("altitude_m", 2037.5)] },
      { action: "rows", load: 1, rows: [withRow("valid_to", "31/12/2099")] },
      { action: "rows", load: 1, rows: [withRow("latitude", "35.7")] },
    ]
  ) {
    const text = JSON.stringify(body);
    let message: string | undefined = undefined;
    if (text !== undefined) {
      message = text.slice(0, 80);
    }
    assertEquals(typeof parseLoadReferencesRequest(body), "string", message);
  }
  assertEquals(parseLoadReferencesRequest({ action: "finish", load: 1, rows: 99_122 }), {
    action: "finish",
    load: 1,
    rows: 99_122,
  });
});

Deno.test("parseLoadReferencesRequest says what is wrong, as the handler answers it", function (): void {
  assertEquals(parseLoadReferencesRequest([]), "body must be a JSON object");
  assertEquals(
    parseLoadReferencesRequest({ action: "load" }),
    "action must be status, begin, rows, finish or abandon",
  );
  assertEquals(
    parseLoadReferencesRequest({ action: "begin", program: "iota", version: "v" }),
    "begin needs a pota, sota or wwff program and a version",
  );
  assertEquals(
    parseLoadReferencesRequest({ action: "rows", load: 1, rows: [] }),
    "rows needs 1 to 5000 rows",
  );
  assertEquals(
    parseLoadReferencesRequest({ action: "finish", load: 1 }),
    "finish needs a load and the rows staged",
  );
  assertEquals(
    parseLoadReferencesRequest({ action: "abandon", load: 1 }),
    "abandon needs a load and an error",
  );
  const row = parseLoadReferencesRequest({
    action: "rows",
    load: 1,
    rows: [ROW, { reference: 1 }],
  });
  assertEquals(
    typeof row === "string" && row.startsWith("every row must be a reference row: 1."),
    true,
    JSON.stringify(row),
  );
});

Deno.test("handleLoadReferences answers 500 when the body cannot be read", async function (): Promise<
  void
> {
  const s = setup({});
  const res = await handleLoadReferences(brokenPost(SECRET), s.deps);
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "connection reset" });
  assertEquals(s.calls.rpc, []);
});
