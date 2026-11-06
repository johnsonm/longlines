import { assertEquals } from "@std/assert";
import { createIsedSpecialDb } from "../db.ts";
import { handleLoadIsedSpecial } from "../handlers/load_ised_special.ts";
import { MAX_ISED_ROWS_PER_REQUEST } from "../ised.ts";
import type { IsedSpecialRow } from "../ised_special.ts";
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
  return new Request("http://x/load-ised-special", init);
}

function brokenPost(secret: string): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.error(new Error("connection reset"));
    },
  });
  return new Request("http://x/load-ised-special", {
    method: "POST",
    headers: { "x-inbound-secret": secret },
    body,
  });
}

function setup(rpc: FakeSupabaseOptions["rpc"]) {
  const fake = fakeSupabase({ rpc });
  const client = fake.client;
  const deps = { secret: SECRET, db: () => createIsedSpecialDb(client) };
  return { deps, calls: fake.calls };
}

async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

const ROW: IsedSpecialRow = {
  callsign: "CF3VEDAY",
  beg_date: "2005-05-01",
  end_date: "2005-05-31",
  event_en: "Grand opening of the Canadian War Museum",
  event_fr: "Grande Ouverture du Musée Canadien de la Guerre",
  call_sign_request: null,
  use_by: "VA3ROR",
};

Deno.test(
  "handleLoadIsedSpecial refuses a missing, wrong, or unconfigured inbound secret",
  async function (): Promise<void> {
    const s = setup({});
    for (const secret of [null, "wrong"]) {
      const res = await handleLoadIsedSpecial(post({ action: "status" }, secret, "POST"), s.deps);
      assertEquals(res.status, 401);
    }
    const unset = await handleLoadIsedSpecial(post({ action: "status" }, SECRET, "POST"), {
      secret: undefined,
      db: s.deps.db,
    });
    assertEquals(unset.status, 500);
    assertEquals(s.calls.rpc, []);
  },
);

Deno.test(
  "handleLoadIsedSpecial rejects non-POST, invalid JSON, broken streams, and bad schemas",
  async function (): Promise<void> {
    const s = setup({});
    assertEquals((await handleLoadIsedSpecial(post(null, SECRET, "GET"), s.deps)).status, 405);

    const badJson = await handleLoadIsedSpecial(post("not json", SECRET, "POST"), s.deps);
    assertEquals(badJson.status, 400);

    const broken = await handleLoadIsedSpecial(brokenPost(SECRET), s.deps);
    assertEquals(broken.status, 500);

    for (
      const body of [
        { action: "status", extra: 1 },
        { action: "begin", version: "   " },
        {
          action: "rows",
          load: 1,
          rows: [{
            callsign: "CF3VEDAY",
            beg_date: "2026-02-31",
            end_date: "2026-03-01",
            event_en: "Bad Date",
            event_fr: null,
            call_sign_request: null,
            use_by: null,
          }],
        },
        {
          action: "rows",
          load: 1,
          rows: Array(MAX_ISED_ROWS_PER_REQUEST + 1).fill(ROW),
        },
      ]
    ) {
      const res = await handleLoadIsedSpecial(post(body, SECRET, "POST"), s.deps);
      assertEquals(res.status, 400);
    }
    assertEquals(s.calls.rpc, []);
  },
);

Deno.test(
  "handleLoadIsedSpecial maps each action to its RPC",
  async function (): Promise<void> {
    const statusPayload = {
      load: { id: 3, version: "v1", status: "applied", started_at: "2026-10-29T00:00:00Z" },
      newestAppliedStartedAt: "2026-10-29T00:00:00Z",
    };
    const s = setup({
      ised_special_load_status: { data: statusPayload },
      ised_special_load_begin: { data: 4 },
      ised_special_load_rows: { data: 1 },
      ised_special_load_finish: { data: null },
      ised_special_load_abandon: { data: null },
    });

    const answers = [];
    for (
      const body of [
        { action: "status" },
        { action: "begin", version: "v2" },
        { action: "rows", load: 4, rows: [ROW] },
        { action: "finish", load: 4, rows: 1 },
        { action: "abandon", load: 4, error: "err" },
      ]
    ) {
      const res = await handleLoadIsedSpecial(post(body, SECRET, "POST"), s.deps);
      assertEquals(res.status, 200);
      answers.push(await res.json());
    }

    assertEquals(answers, [
      statusPayload,
      { load: 4 },
      { staged: 1 },
      { ok: true },
      { ok: true },
    ]);
    assertEquals(s.calls.rpc, [
      { fn: "ised_special_load_status", args: undefined },
      { fn: "ised_special_load_begin", args: { p_version: "v2" } },
      { fn: "ised_special_load_rows", args: { p_load: 4, p_rows: [ROW] } },
      { fn: "ised_special_load_finish", args: { p_load: 4, p_rows: 1 } },
      { fn: "ised_special_load_abandon", args: { p_load: 4, p_error: "err" } },
    ]);
  },
);

Deno.test(
  "handleLoadIsedSpecial answers 500 with database error or thrown non-Error",
  async function (): Promise<void> {
    const deps = setup({
      ised_special_load_finish: { error: { message: "staged only 1 rows (floor 10)" } },
    }).deps;
    const res = await handleLoadIsedSpecial(
      post({ action: "finish", load: 1, rows: 1 }, SECRET, "POST"),
      deps,
    );
    assertEquals(res.status, 500);
    assertEquals(
      (await res.json()).error,
      "ised_special_load_finish failed: staged only 1 rows (floor 10)",
    );

    const nonErr = await handleLoadIsedSpecial(post({ action: "status" }, SECRET, "POST"), {
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
