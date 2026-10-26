import { assertEquals } from "@std/assert";
import { createLicenseDb } from "../db.ts";
import { handleLoadLicenses, parseLoadRequest } from "../handlers/load_licenses.ts";
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
  return new Request("http://x/load-licenses", init);
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
  const deps = { secret: SECRET, db: () => createLicenseDb(client) };
  return { deps, calls: fake.calls };
}

// Rejects with whatever it is given, so a test can reject with a non-Error.
async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

Deno.test(
  "handleLoadLicenses refuses a missing or wrong relay secret",
  async function (): Promise<void> {
    const s = setup({});
    for (const secret of [null, "wrong"]) {
      assertEquals(
        (await handleLoadLicenses(post({ action: "status" }, secret, "POST"), s.deps)).status,
        401,
      );
    }
    const unset = await handleLoadLicenses(post({ action: "status" }, SECRET, "POST"), {
      secret: undefined,
      db: s.deps.db,
    });
    assertEquals(unset.status, 500);
    assertEquals(s.calls.rpc, []);
  },
);

Deno.test(
  "handleLoadLicenses takes POST with a JSON body only",
  async function (): Promise<void> {
    const deps = setup({}).deps;
    assertEquals((await handleLoadLicenses(post(null, SECRET, "GET"), deps)).status, 405);
    const bad = await handleLoadLicenses(post("not json", SECRET, "POST"), deps);
    assertEquals([bad.status, (await bad.json()).error], [400, "request body is not JSON"]);
    const invalid = await handleLoadLicenses(post({ action: "drop" }, SECRET, "POST"), deps);
    assertEquals(invalid.status, 400);
  },
);

Deno.test(
  "handleLoadLicenses maps each action to its RPC",
  async function (): Promise<void> {
    const load = { id: 7, version: "v", status: "applied", started_at: "2026-10-12T00:00:00Z" };
    const s = setup({
      fcc_license_load_status: { data: load },
      fcc_license_load_begin: { data: 8 },
      fcc_license_load_rows: { data: 2 },
      fcc_license_load_finish: { data: null },
      fcc_license_load_abandon: { data: null },
    });
    const rows = [{ usi: 1, operator_class: "General" }, { usi: 2, operator_class: null }];
    const counts = { HD: 1, EN: 1, AM: 2 };
    const answers = [];
    for (
      const body of [
        { action: "status" },
        { action: "begin", version: "v" },
        { action: "rows", load: 8, kind: "AM", rows },
        { action: "finish", load: 8, counts },
        { action: "abandon", load: 8, error: "x".repeat(1200) },
      ]
    ) {
      const res = await handleLoadLicenses(post(body, SECRET, "POST"), s.deps);
      assertEquals(res.status, 200);
      answers.push(await res.json());
    }
    assertEquals(answers, [{ load }, { load: 8 }, { staged: 2 }, { ok: true }, { ok: true }]);
    assertEquals(s.calls.rpc, [
      { fn: "fcc_license_load_status", args: undefined },
      { fn: "fcc_license_load_begin", args: { p_version: "v" } },
      { fn: "fcc_license_load_rows", args: { p_load: 8, p_kind: "AM", p_rows: rows } },
      { fn: "fcc_license_load_finish", args: { p_load: 8, p_counts: counts } },
      { fn: "fcc_license_load_abandon", args: { p_load: 8, p_error: "x".repeat(1000) } },
    ]);
  },
);

Deno.test(
  "handleLoadLicenses answers 500 with the database error",
  async function (): Promise<void> {
    const deps = setup({
      fcc_license_load_finish: { error: { message: "staged {} but the relay sent {}" } },
    }).deps;
    const res = await handleLoadLicenses(
      post({ action: "finish", load: 1, counts: { HD: 0, EN: 0, AM: 0 } }, SECRET, "POST"),
      deps,
    );
    assertEquals(res.status, 500);
    assertEquals(
      (await res.json()).error,
      "fcc_license_load_finish failed: staged {} but the relay sent {}",
    );
  },
);

Deno.test(
  "handleLoadLicenses reports a thrown non-Error as text",
  async function (): Promise<void> {
    const res = await handleLoadLicenses(post({ action: "status" }, SECRET, "POST"), {
      secret: SECRET,
      db: () => ({
        loadStatus: () => rejectWith("socket closed"),
        beginLoad: () => Promise.resolve(0),
        stageRows: () => Promise.resolve(0),
        finishLoad: () => Promise.resolve(),
        abandonLoad: () => Promise.resolve(),
      }),
    });
    assertEquals([res.status, (await res.json()).error], [500, "socket closed"]);
  },
);

Deno.test("parseLoadRequest rejects malformed requests", function (): void {
  const row = { usi: 1 };
  for (
    const body of [
      null,
      [],
      { action: "begin" },
      { action: "begin", version: " " },
      { action: "begin", version: "x".repeat(101) },
      { action: "rows", load: 1, kind: "LA", rows: [row] },
      { action: "rows", load: -1, kind: "HD", rows: [row] },
      { action: "rows", load: 1, kind: "HD", rows: [] },
      { action: "rows", load: 1, kind: "HD", rows: Array(10_001).fill(row) },
      { action: "rows", load: 1, kind: "HD", rows: [row, "HD|1|"] },
      { action: "finish", load: 1, counts: { HD: 1, EN: 1 } },
      { action: "finish", load: 1, counts: { HD: 1, EN: 1, AM: 1.5 } },
      { action: "finish", load: "1", counts: { HD: 1, EN: 1, AM: 1 } },
      { action: "abandon", load: 1 },
      { action: "abandon", load: -1, error: "x" },
      // Strict: the relay sends exactly these keys, so any other is refused.
      { action: "status", extra: 1 },
      { action: "finish", load: 1, counts: { HD: 1, EN: 2, AM: 3, X: 4 } },
      { action: "rows", load: 1, kind: "AM", rows: [{ usi: 1, operator_class: "General", x: 1 }] },
      { action: "rows", load: 1, kind: "AM", rows: [{ usi: "1", operator_class: "General" }] },
      { action: "rows", load: 1, kind: "HD", rows: [{ usi: 1, operator_class: "General" }] },
    ]
  ) {
    const text = JSON.stringify(body);
    let message: string | undefined = undefined;
    if (text !== undefined) {
      message = text.slice(0, 80);
    }
    assertEquals(typeof parseLoadRequest(body), "string", message);
  }
  assertEquals(
    parseLoadRequest({ action: "finish", load: 1, counts: { HD: 1, EN: 2, AM: 3 } }),
    {
      action: "finish",
      load: 1,
      counts: { HD: 1, EN: 2, AM: 3 },
    },
  );
});

Deno.test("parseLoadRequest says what is wrong, as the handler answers it", function (): void {
  assertEquals(parseLoadRequest([]), "body must be a JSON object");
  assertEquals(
    parseLoadRequest({ action: "load" }),
    "action must be status, begin, rows, finish or abandon",
  );
  assertEquals(parseLoadRequest({ action: "begin", version: " " }), "begin needs a version");
  assertEquals(
    parseLoadRequest({ action: "rows", load: 1, kind: "LA", rows: [{ usi: 1 }] }),
    "rows needs a load and an HD, EN or AM kind",
  );
  assertEquals(
    parseLoadRequest({ action: "rows", load: 1, kind: "HD", rows: [] }),
    "rows needs 1 to 10000 rows",
  );
  assertEquals(
    parseLoadRequest({ action: "finish", load: 1, counts: { HD: 1, EN: 1 } }),
    "finish needs a load and a count per kind",
  );
  assertEquals(
    parseLoadRequest({ action: "abandon", load: 1 }),
    "abandon needs a load and an error",
  );
  const row = parseLoadRequest({ action: "rows", load: 1, kind: "AM", rows: [{ usi: 1 }] });
  assertEquals(typeof row === "string" && row.startsWith("every row must be an AM row: "), true);
});

Deno.test("handleLoadLicenses answers 500 when the body cannot be read", async function (): Promise<
  void
> {
  const s = setup({});
  const res = await handleLoadLicenses(brokenPost(SECRET), s.deps);
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "connection reset" });
  assertEquals(s.calls.rpc, []);
});
