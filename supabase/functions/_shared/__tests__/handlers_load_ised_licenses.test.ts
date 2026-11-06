import { assertEquals } from "@std/assert";
import { createIsedLicenseDb } from "../db.ts";
import { handleLoadIsedLicenses } from "../handlers/load_ised_licenses.ts";
import { type IsedRow, MAX_ISED_ROWS_PER_REQUEST } from "../ised.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const SECRET = "inbound-secret";

function post(body: unknown, secret: string | null, method: string): Request {
  const init: RequestInit = { method, headers: {} };
  if (secret !== null) {
    init.headers = { "x-inbound-secret": secret };
  }
  if (method === "POST") {
    if (typeof body === "string") {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }
  return new Request("http://x/load-ised-licenses", init);
}

function brokenPost(secret: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(new Error("connection reset"));
    },
  });
  return new Request("http://x/load-ised-licenses", {
    method: "POST",
    headers: { "x-inbound-secret": secret },
    body,
  });
}

function setup(rpc: FakeSupabaseOptions["rpc"]) {
  const fake = fakeSupabase({ rpc });
  const client = fake.client;
  const deps = { secret: SECRET, db: () => createIsedLicenseDb(client) };
  return { deps, calls: fake.calls };
}

async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

const ROW: IsedRow = {
  callsign: "VE3TSS",
  first_name: "Hélène",
  last_name: "McFadden",
  club_name: null,
  province: "ON",
  qualifications: "ACD",
};

Deno.test(
  "handleLoadIsedLicenses refuses a missing, wrong, or unconfigured inbound secret",
  async function (): Promise<void> {
    const s = setup({});
    for (const secret of [null, "wrong"]) {
      const res = await handleLoadIsedLicenses(post({ action: "status" }, secret, "POST"), s.deps);
      assertEquals(res.status, 401);
    }
    const unset = await handleLoadIsedLicenses(post({ action: "status" }, SECRET, "POST"), {
      secret: undefined,
      db: s.deps.db,
    });
    assertEquals(unset.status, 500);
    assertEquals(s.calls.rpc, []);
  },
);

Deno.test(
  "handleLoadIsedLicenses rejects non-POST, invalid JSON, broken streams, and bad schemas",
  async function (): Promise<void> {
    const s = setup({});
    assertEquals((await handleLoadIsedLicenses(post(null, SECRET, "GET"), s.deps)).status, 405);

    const badJson = await handleLoadIsedLicenses(post("not json", SECRET, "POST"), s.deps);
    assertEquals(badJson.status, 400);

    const broken = await handleLoadIsedLicenses(brokenPost(SECRET), s.deps);
    assertEquals(broken.status, 500);

    for (
      const body of [
        { action: "status", extra: 1 },
        { action: "begin", version: "   " },
        {
          action: "rows",
          load: 1,
          rows: [{
            callsign: "VE3TSS",
            first_name: "A",
            last_name: "B",
            club_name: null,
            province: "ON",
            qualifications: "A",
            address_line: "123 Main St",
          }],
        },
        {
          action: "rows",
          load: 1,
          rows: Array(MAX_ISED_ROWS_PER_REQUEST + 1).fill(ROW),
        },
      ]
    ) {
      const res = await handleLoadIsedLicenses(post(body, SECRET, "POST"), s.deps);
      assertEquals(res.status, 400);
    }
    assertEquals(s.calls.rpc, []);
  },
);

Deno.test(
  "handleLoadIsedLicenses maps each action to its RPC",
  async function (): Promise<void> {
    const statusPayload = {
      load: { id: 7, version: "v1", status: "applied", started_at: "2026-10-29T00:00:00Z" },
      newestAppliedStartedAt: "2026-10-29T00:00:00Z",
    };
    const s = setup({
      ised_license_load_status: { data: statusPayload },
      ised_license_load_begin: { data: 8 },
      ised_license_load_rows: { data: 1 },
      ised_license_load_finish: { data: null },
      ised_license_load_abandon: { data: null },
    });

    const answers = [];
    for (
      const body of [
        { action: "status" },
        { action: "begin", version: "v2" },
        { action: "rows", load: 8, rows: [ROW] },
        { action: "finish", load: 8, rows: 1 },
        { action: "abandon", load: 8, error: "err" },
      ]
    ) {
      const res = await handleLoadIsedLicenses(post(body, SECRET, "POST"), s.deps);
      assertEquals(res.status, 200);
      answers.push(await res.json());
    }

    assertEquals(answers, [
      statusPayload,
      { load: 8 },
      { staged: 1 },
      { ok: true },
      { ok: true },
    ]);
    assertEquals(s.calls.rpc, [
      { fn: "ised_license_load_status", args: undefined },
      { fn: "ised_license_load_begin", args: { p_version: "v2" } },
      { fn: "ised_license_load_rows", args: { p_load: 8, p_rows: [ROW] } },
      { fn: "ised_license_load_finish", args: { p_load: 8, p_rows: 1 } },
      { fn: "ised_license_load_abandon", args: { p_load: 8, p_error: "err" } },
    ]);
  },
);

Deno.test(
  "handleLoadIsedLicenses answers 500 with database error or thrown non-Error",
  async function (): Promise<void> {
    const deps = setup({
      ised_license_load_finish: { error: { message: "staged only 1 rows (floor 80000)" } },
    }).deps;
    const res = await handleLoadIsedLicenses(
      post({ action: "finish", load: 1, rows: 1 }, SECRET, "POST"),
      deps,
    );
    assertEquals(res.status, 500);
    assertEquals(
      (await res.json()).error,
      "ised_license_load_finish failed: staged only 1 rows (floor 80000)",
    );

    const nonErr = await handleLoadIsedLicenses(post({ action: "status" }, SECRET, "POST"), {
      secret: SECRET,
      db: () => ({
        loadStatus: () => rejectWith("socket closed"),
        beginLoad: () => Promise.resolve(0),
        stageRows: () => Promise.resolve(0),
        finishLoad: () => Promise.resolve(),
        abandonLoad: () => Promise.resolve(),
      }),
    });
    assertEquals([nonErr.status, (await nonErr.json()).error], [500, "socket closed"]);
  },
);
