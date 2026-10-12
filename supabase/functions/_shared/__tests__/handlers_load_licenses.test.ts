import { assertEquals } from "@std/assert";
import { createLicenseDb } from "../db.ts";
import { handleLoadLicenses, parseLoadRequest } from "../handlers/load_licenses.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const SECRET = "relay-secret";
const post = (body: unknown, secret: string | null = SECRET, method = "POST") =>
  new Request("http://x/load-licenses", {
    method,
    headers: secret === null ? {} : { "x-relay-secret": secret },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });

function setup(rpc: FakeSupabaseOptions["rpc"] = {}) {
  const { client, calls } = fakeSupabase({ rpc });
  const deps = { secret: SECRET, db: () => createLicenseDb(client) };
  return { deps, calls };
}

Deno.test("handleLoadLicenses refuses a missing or wrong relay secret", async () => {
  const { deps, calls } = setup();
  for (const secret of [null, "wrong"]) {
    assertEquals((await handleLoadLicenses(post({ action: "status" }, secret), deps)).status, 401);
  }
  const unset = await handleLoadLicenses(post({ action: "status" }), {
    ...deps,
    secret: undefined,
  });
  assertEquals(unset.status, 500);
  assertEquals(calls.rpc, []);
});

Deno.test("handleLoadLicenses takes POST with a JSON body only", async () => {
  const { deps } = setup();
  assertEquals((await handleLoadLicenses(post(null, SECRET, "GET"), deps)).status, 405);
  const bad = await handleLoadLicenses(post("not json"), deps);
  assertEquals([bad.status, (await bad.json()).error], [400, "request body is not JSON"]);
  const invalid = await handleLoadLicenses(post({ action: "drop" }), deps);
  assertEquals(invalid.status, 400);
});

Deno.test("handleLoadLicenses maps each action to its RPC", async () => {
  const load = { id: 7, version: "v", status: "applied", started_at: "2026-10-12T00:00:00Z" };
  const { deps, calls } = setup({
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
    const res = await handleLoadLicenses(post(body), deps);
    assertEquals(res.status, 200);
    answers.push(await res.json());
  }
  assertEquals(answers, [{ load }, { load: 8 }, { staged: 2 }, { ok: true }, { ok: true }]);
  assertEquals(calls.rpc, [
    { fn: "fcc_license_load_status", args: undefined },
    { fn: "fcc_license_load_begin", args: { p_version: "v" } },
    { fn: "fcc_license_load_rows", args: { p_load: 8, p_kind: "AM", p_rows: rows } },
    { fn: "fcc_license_load_finish", args: { p_load: 8, p_counts: counts } },
    { fn: "fcc_license_load_abandon", args: { p_load: 8, p_error: "x".repeat(1000) } },
  ]);
});

Deno.test("handleLoadLicenses answers 500 with the database error", async () => {
  const { deps } = setup({
    fcc_license_load_finish: { error: { message: "staged {} but the relay sent {}" } },
  });
  const res = await handleLoadLicenses(
    post({ action: "finish", load: 1, counts: { HD: 0, EN: 0, AM: 0 } }),
    deps,
  );
  assertEquals(res.status, 500);
  assertEquals(
    (await res.json()).error,
    "fcc_license_load_finish failed: staged {} but the relay sent {}",
  );
});

Deno.test("handleLoadLicenses reports a thrown non-Error as text", async () => {
  const res = await handleLoadLicenses(post({ action: "status" }), {
    secret: SECRET,
    db: () => ({
      loadStatus: () => Promise.reject("socket closed"),
      beginLoad: () => Promise.resolve(0),
      stageRows: () => Promise.resolve(0),
      finishLoad: () => Promise.resolve(),
      abandonLoad: () => Promise.resolve(),
    }),
  });
  assertEquals([res.status, (await res.json()).error], [500, "socket closed"]);
});

Deno.test("parseLoadRequest rejects malformed requests", () => {
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
    ]
  ) {
    assertEquals(typeof parseLoadRequest(body), "string", JSON.stringify(body)?.slice(0, 80));
  }
  assertEquals(
    parseLoadRequest({ action: "finish", load: 1, counts: { HD: 1, EN: 2, AM: 3, X: 4 } }),
    {
      action: "finish",
      load: 1,
      counts: { HD: 1, EN: 2, AM: 3 },
    },
  );
});
