import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  handleRelayApi,
  MAX_BODY_BYTES,
  MAX_POLLS_PER_MINUTE,
  MAX_REQUESTS_PER_MINUTE,
  MAX_STARTS_PER_MINUTE,
  relayPath,
  relayRoute,
} from "../handlers/relay_api.ts";
import { hashApiToken } from "../api/token.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import type { JsonObject } from "../types.ts";
import { type FakeCalls, fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

// The example request of docs/contract.md (sonyccd/longlines-relay), section 6: a new contact, an
// edit, a delete, and a contact logged under another call, 20:31 to 21:15:45Z.
const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/logged-contacts.json", import.meta.url)),
) as { relay_version: string; contacts: JsonObject[] };

const NOW = new Date("2026-10-28T21:20:15Z");
const KEY = await hmacKey("test-secret");
const BASE = "http://127.0.0.1:54321/functions/v1/relay-api";
const TOKEN = "ll_relay_" + "a".repeat(52);
const USER = "11111111-1111-1111-1111-111111111111";
const TOKEN_ROW = { token_id: "t-1", user_id: USER, scopes: ["contacts:write"] };
const READ_ONLY_ROW = { token_id: "t-1", user_id: USER, scopes: ["spots:read"] };
const ACCOUNT = { callsign: "KK4PWJ", email: "operator@example.com" };
const START_REPLY = {
  device_code: "5c6f2b1e0f7a4c0f9e3b8d2a61c4e7f0b9a3d5e8c1f2a4b6",
  user_code: "WDJB-MJHT",
  verification_uri: "https://longlines.io/relay/approve",
  verification_uri_complete: "https://longlines.io/relay/approve?code=WDJB-MJHT",
  expires_in: 600,
  interval: 5,
};
const START_BODY = {
  client_name: "Long Lines Relay",
  client_version: "0.1.0",
  device_name: " SHACK-PC ",
};

interface Run {
  res: Response;
  body: unknown;
  calls: FakeCalls;
}

// key null runs without the HMAC key. Every RPC a request may reach answers as a healthy
// database would unless options overrides it.
async function run(
  req: Request,
  options: FakeSupabaseOptions,
  key: CryptoKey | null,
): Promise<Run> {
  const rpc: NonNullable<FakeSupabaseOptions["rpc"]> = {
    record_profile_lookup: { data: 1 },
    authenticate_relay_token: { data: [TOKEN_ROW] },
    record_relay_contacts: { data: 0 },
    match_pending_spots: { data: 1 },
  };
  if (options.rpc !== undefined) {
    for (const entry of Object.entries(options.rpc)) {
      rpc[entry[0]] = entry[1];
    }
  }
  const fake = fakeSupabase({ rpc });
  let hmac: CryptoKey | undefined;
  if (key !== null) {
    hmac = key;
  }
  const res = await handleRelayApi(
    req,
    { db: () => fake.client, clientIpHeader: undefined, key: hmac },
    NOW,
  );
  const body: unknown = await res.json();
  return { res, body, calls: fake.calls };
}

function post(path: string, body: unknown, headers: Record<string, string>): Request {
  const all: Record<string, string> = { "Content-Type": "application/json" };
  for (const entry of Object.entries(headers)) {
    all[entry[0]] = entry[1];
  }
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: all,
    body: JSON.stringify(body),
  });
}

function getMe(headers: Record<string, string>): Request {
  return new Request(`${BASE}/v1/me`, { headers });
}

const AUTHED = { Authorization: `Bearer ${TOKEN}` };

function rpcNames(calls: FakeCalls): string[] {
  return calls.rpc.map((c) => c.fn);
}

function rpcArgs(calls: FakeCalls, fn: string): Record<string, unknown> | undefined {
  for (const call of calls.rpc) {
    if (call.fn === fn) {
      return call.args;
    }
  }
  return undefined;
}

/** The items apply_logged_contacts was sent. */
function appliedItems(calls: FakeCalls): JsonObject[] {
  const args = rpcArgs(calls, "apply_logged_contacts");
  if (args === undefined) {
    return [];
  }
  return args["p_items"] as JsonObject[];
}

/** One apply_logged_contacts result: created unless `statuses` names the item. */
function resultFor(item: JsonObject, statuses: Record<string, string>): JsonObject {
  const id = String(item["external_id"]);
  let status = statuses[id];
  if (status === undefined) {
    status = "created";
  }
  if (status === "mycall_mismatch") {
    return { external_id: id, status: "rejected", reason: "mycall_mismatch" };
  }
  return { external_id: id, status };
}

/** apply_logged_contacts answering each item it is sent. */
function applyAnswering(statuses: Record<string, string>) {
  return function (args: Record<string, unknown> | undefined) {
    let items: JsonObject[] = [];
    if (args !== undefined) {
      items = args["p_items"] as JsonObject[];
    }
    return { data: items.map((i) => resultFor(i, statuses)) };
  };
}

function errorOf(body: unknown): unknown {
  return (body as JsonObject)["error"];
}

/** Runs fn with console.error captured, returning what it logged. */
async function capturingErrors(fn: () => Promise<void>): Promise<string[]> {
  const error = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => logged.push(String(args[0]));
  try {
    await fn();
  } finally {
    console.error = error;
  }
  return logged;
}

Deno.test("relayPath reads the path after the function's name, locally and hosted", function (): void {
  assertEquals(relayPath("/functions/v1/relay-api/v1/me"), "/v1/me");
  assertEquals(relayPath("/relay-api/v1/device/start/"), "/v1/device/start");
  assertEquals(relayPath("/relay-api"), "");
  assertEquals(relayPath("/functions/v1/api/v1/me"), null);
});

Deno.test("relayRoute knows the four v1 routes and nothing else", function (): void {
  assertEquals(relayRoute("POST", "/v1/device/start"), "device/start");
  assertEquals(relayRoute("POST", "/v1/device/token"), "device/token");
  assertEquals(relayRoute("GET", "/v1/me"), "me");
  assertEquals(relayRoute("POST", "/v1/contacts"), "contacts");
  assertEquals(relayRoute("GET", "/v1/contacts"), null);
  assertEquals(relayRoute("GET", "/v1/spots"), null);
  assertEquals(relayRoute("GET", "/v2/me"), null);
});

Deno.test("unknown paths, methods and versions are 404 not_found before any database call", async function (): Promise<
  void
> {
  for (
    const req of [
      new Request(`${BASE}/v1/spots`),
      new Request(`${BASE}/v2/me`, { headers: AUTHED }),
      new Request(`${BASE}/v1/me`, { method: "POST" }),
      new Request(`${BASE}/v1/contacts`, { method: "OPTIONS" }),
      new Request("http://127.0.0.1:54321/functions/v1/api/v1/me"),
    ]
  ) {
    const r = await run(req, {}, KEY);
    assertEquals(r.res.status, 404);
    assertEquals(r.body, { error: "not_found" });
    assertEquals(r.calls.rpc, []);
  }
});

Deno.test("responses are JSON and never cached", async function (): Promise<void> {
  const r = await run(new Request(`${BASE}/v1/spots`), {}, KEY);
  assertEquals(r.res.headers.get("Cache-Control"), "no-store");
  assertEquals(r.res.headers.get("Content-Type"), "application/json");
});

Deno.test("without the HMAC key every route fails closed", async function (): Promise<void> {
  const r = await run(getMe(AUTHED), {}, null);
  assertEquals(r.res.status, 500);
  assertEquals(r.body, { error: "server_error" });
  assertEquals(r.calls.rpc, []);
});

Deno.test("each route counts the client in its own bucket, apart from profile lookups", async function (): Promise<
  void
> {
  const subject = await hmacSha256Hex(KEY, "203.0.113.9");
  const from = { "cf-connecting-ip": "203.0.113.9" };
  const cases: Array<[Request, string]> = [
    [post("/v1/device/start", {}, from), `relay-start:${subject}`],
    [post("/v1/device/token", {}, from), `relay-poll:${subject}`],
    [getMe(from), `relay:${subject}`],
    [post("/v1/contacts", {}, from), `relay:${subject}`],
  ];
  for (const entry of cases) {
    const r = await run(entry[0], {}, KEY);
    assertEquals(rpcArgs(r.calls, "record_profile_lookup"), { p_client: entry[1] });
  }
});

Deno.test("past a route's per-client limit the answer is 429 rate_limited with Retry-After", async function (): Promise<
  void
> {
  const cases: Array<[() => Request, number]> = [
    [() => post("/v1/device/start", START_BODY, {}), MAX_STARTS_PER_MINUTE],
    [() => post("/v1/device/token", { device_code: "abc" }, {}), MAX_POLLS_PER_MINUTE],
    [() => getMe(AUTHED), MAX_REQUESTS_PER_MINUTE],
  ];
  for (const entry of cases) {
    const limit = entry[1];
    const atLimit = await run(entry[0](), {
      rpc: {
        record_profile_lookup: { data: limit },
        start_relay_pairing: { data: START_REPLY },
        poll_relay_pairing: { data: { status: "authorization_pending" } },
        relay_account: { data: ACCOUNT },
      },
    }, KEY);
    assertEquals(atLimit.res.status === 429, false, "a client at its limit passes");
    const over = await run(
      entry[0](),
      { rpc: { record_profile_lookup: { data: limit + 1 } } },
      KEY,
    );
    assertEquals(over.res.status, 429);
    assertEquals(over.res.headers.get("Retry-After"), "45");
    assertEquals(errorOf(over.body), "rate_limited");
    assertEquals(rpcNames(over.calls), ["record_profile_lookup"]);
  }
});

Deno.test("a per-client limit that cannot be read fails closed", async function (): Promise<void> {
  for (const answer of [{ error: { message: "down" } }, { data: "many" }]) {
    const r = await run(post("/v1/device/start", START_BODY, {}), {
      rpc: { record_profile_lookup: answer },
    }, KEY);
    assertEquals(r.res.status, 500);
    assertEquals(r.body, { error: "server_error" });
  }
});

// ---- device/start -------------------------------------------------------------

Deno.test("device/start starts a pairing and answers the contract's fields only", async function (): Promise<
  void
> {
  const reply: JsonObject = { extra: 1 };
  for (const entry of Object.entries(START_REPLY)) {
    reply[entry[0]] = entry[1];
  }
  const body: JsonObject = { os: "windows" };
  for (const entry of Object.entries(START_BODY)) {
    body[entry[0]] = entry[1];
  }
  const r = await run(post("/v1/device/start", body, {}), {
    rpc: { start_relay_pairing: { data: reply } },
  }, KEY);
  assertEquals(r.res.status, 200);
  assertEquals(r.body, START_REPLY);
  assertEquals(rpcArgs(r.calls, "start_relay_pairing"), {
    p_device_name: "SHACK-PC",
    p_client_version: "0.1.0",
  });
});

/** START_BODY with one field replaced. */
function startWith(key: string, value: unknown): JsonObject {
  const body: JsonObject = {};
  for (const entry of Object.entries(START_BODY)) {
    body[entry[0]] = entry[1];
  }
  body[key] = value;
  return body;
}

Deno.test("device/start refuses a body that breaks the contract with 400 invalid_request", async function (): Promise<
  void
> {
  const bad: unknown[] = [
    startWith("client_name", "Other App"),
    startWith("device_name", "   "),
    startWith("device_name", "x".repeat(65)),
    startWith("device_name", "PC\u0000"),
    startWith("device_name", "PC\ud800"),
    startWith("client_version", ""),
    { client_name: "Long Lines Relay" },
    [],
    "text",
  ];
  for (const body of bad) {
    const r = await run(post("/v1/device/start", body, {}), {
      rpc: { start_relay_pairing: { data: START_REPLY } },
    }, KEY);
    assertEquals(r.res.status, 400, JSON.stringify(body));
    assertEquals(errorOf(r.body), "invalid_request");
    assertEquals(typeof (r.body as JsonObject)["message"], "string");
    assertEquals(rpcNames(r.calls).includes("start_relay_pairing"), false);
  }
});

Deno.test("a body that is not JSON or is over 256 KiB is 400 invalid_request", async function (): Promise<
  void
> {
  const notJson = await run(
    new Request(`${BASE}/v1/device/start`, { method: "POST", body: "{" }),
    {},
    KEY,
  );
  assertEquals(notJson.res.status, 400);
  assertEquals(notJson.body, { error: "invalid_request", message: "The body is not JSON." });

  const big = new Request(`${BASE}/v1/device/start`, {
    method: "POST",
    body: JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) }),
  });
  const tooBig = await run(big, {}, KEY);
  assertEquals(tooBig.res.status, 400);
  assertEquals(errorOf(tooBig.body), "invalid_request");
});

Deno.test("device/start answers 500 when the pairing cannot be started", async function (): Promise<
  void
> {
  for (const answer of [{ error: { message: "down" } }, { data: { device_code: "x" } }]) {
    const r = await run(post("/v1/device/start", START_BODY, {}), {
      rpc: { start_relay_pairing: answer },
    }, KEY);
    assertEquals(r.res.status, 500);
    assertEquals(r.body, { error: "server_error" });
  }
});

// ---- device/token -------------------------------------------------------------

Deno.test("device/token polls by the device code's hash and answers each state as 4.2 says", async function (): Promise<
  void
> {
  for (const status of ["authorization_pending", "slow_down", "access_denied", "expired_token"]) {
    const r = await run(post("/v1/device/token", { device_code: "abc", extra: true }, {}), {
      rpc: { poll_relay_pairing: { data: { status } } },
    }, KEY);
    assertEquals(r.res.status, 400);
    assertEquals(r.body, { error: status });
    assertEquals(rpcArgs(r.calls, "poll_relay_pairing"), {
      p_device_code_hash: await hashApiToken("abc"),
    });
  }
});

Deno.test("device/token hands out an approved pairing's token", async function (): Promise<void> {
  const r = await run(post("/v1/device/token", { device_code: "abc" }, {}), {
    rpc: {
      poll_relay_pairing: {
        data: { status: "ok", access_token: TOKEN, scopes: ["contacts:write"] },
      },
    },
  }, KEY);
  assertEquals(r.res.status, 200);
  assertEquals(r.res.headers.get("Cache-Control"), "no-store");
  assertEquals(r.body, { access_token: TOKEN, token_type: "bearer", scopes: ["contacts:write"] });
});

Deno.test("device/token refuses a missing or oversized device code", async function (): Promise<
  void
> {
  for (
    const body of [{}, { device_code: "" }, { device_code: "x".repeat(129) }, { device_code: 7 }]
  ) {
    const r = await run(post("/v1/device/token", body, {}), {}, KEY);
    assertEquals(r.res.status, 400);
    assertEquals(errorOf(r.body), "invalid_request");
    assertEquals(rpcNames(r.calls), ["record_profile_lookup"]);
  }
});

Deno.test("device/token answers 500 when the poll fails or answers out of shape", async function (): Promise<
  void
> {
  for (
    const answer of [
      { error: { message: "down" } },
      { data: { status: "maybe" } },
      { data: { status: "ok" } },
    ]
  ) {
    const r = await run(post("/v1/device/token", { device_code: "abc" }, {}), {
      rpc: { poll_relay_pairing: answer },
    }, KEY);
    assertEquals(r.res.status, 500);
    assertEquals(r.body, { error: "server_error" });
  }
});

// ---- authentication and me ------------------------------------------------------

Deno.test("a missing or malformed token is 401 bad_token without a lookup", async function (): Promise<
  void
> {
  const cases: Array<Record<string, string>> = [
    {},
    { Authorization: "Bearer ll_live_" + "a".repeat(52) },
    { Authorization: `Bearer ${TOKEN}x` },
    { Authorization: TOKEN },
  ];
  for (const headers of cases) {
    const r = await run(getMe(headers), {}, KEY);
    assertEquals(r.res.status, 401);
    assertEquals(r.body, { error: "bad_token" });
    assertEquals(rpcNames(r.calls), ["record_profile_lookup"]);
  }
});

Deno.test("an unknown or revoked token is 401 bad_token", async function (): Promise<void> {
  for (const answer of [{ data: [] }, { data: null }]) {
    const r = await run(getMe(AUTHED), { rpc: { authenticate_relay_token: answer } }, KEY);
    assertEquals(r.res.status, 401);
    assertEquals(r.body, { error: "bad_token" });
    assertEquals(rpcArgs(r.calls, "authenticate_relay_token"), {
      p_token_hash: await hashApiToken(TOKEN),
    });
  }
});

Deno.test("a token lookup that fails is 500, never 401", async function (): Promise<void> {
  for (const answer of [{ error: { message: "down" } }, { data: [{ token_id: 1 }] }]) {
    const r = await run(getMe(AUTHED), { rpc: { authenticate_relay_token: answer } }, KEY);
    assertEquals(r.res.status, 500);
    assertEquals(r.body, { error: "server_error" });
  }
});

Deno.test("me answers the token owner's callsign and email", async function (): Promise<void> {
  const r = await run(getMe(AUTHED), { rpc: { relay_account: { data: ACCOUNT } } }, KEY);
  assertEquals(r.res.status, 200);
  assertEquals(r.body, ACCOUNT);
  assertEquals(rpcArgs(r.calls, "relay_account"), { p_user_id: USER });
});

Deno.test("me needs no particular scope", async function (): Promise<void> {
  const r = await run(getMe(AUTHED), {
    rpc: {
      authenticate_relay_token: { data: [READ_ONLY_ROW] },
      relay_account: { data: ACCOUNT },
    },
  }, KEY);
  assertEquals(r.res.status, 200);
});

Deno.test("me answers 500 when the account cannot be read", async function (): Promise<void> {
  for (
    const answer of [{ error: { message: "down" } }, { data: null }, { data: { callsign: "" } }]
  ) {
    const r = await run(getMe(AUTHED), { rpc: { relay_account: answer } }, KEY);
    assertEquals(r.res.status, 500);
    assertEquals(r.body, { error: "server_error" });
  }
});

// ---- contacts ---------------------------------------------------------------------

/** The fixture's first item with a new external_id and timestamp_utc. */
function contactAt(externalId: string, timestamp: string): JsonObject {
  const item: JsonObject = {};
  const first = fixture.contacts[0];
  if (first !== undefined) {
    for (const entry of Object.entries(first)) {
      item[entry[0]] = entry[1];
    }
  }
  item["external_id"] = externalId;
  item["timestamp_utc"] = timestamp;
  return item;
}

Deno.test("contacts needs contacts:write: 403 insufficient_scope without it", async function (): Promise<
  void
> {
  const r = await run(post("/v1/contacts", fixture, AUTHED), {
    rpc: { authenticate_relay_token: { data: [READ_ONLY_ROW] } },
  }, KEY);
  assertEquals(r.res.status, 403);
  assertEquals(r.body, { error: "insufficient_scope" });
  assertEquals(rpcNames(r.calls).includes("record_relay_contacts"), false);
});

Deno.test("contacts applies the contract's example batch and answers every item in order", async function (): Promise<
  void
> {
  const r = await run(post("/v1/contacts", fixture, AUTHED), {
    rpc: {
      apply_logged_contacts: applyAnswering({
        "a7e1b9c0d2f34e5a8b6c7d8e9f0a1b2c": "updated",
        "0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e": "retracted",
        "f79e495bd37010e153bd2da07fd4eb22a248faa643887dffdd1d33e918e1c91c": "mycall_mismatch",
      }),
    },
  }, KEY);
  assertEquals(r.res.status, 200);
  assertEquals(r.body, {
    results: [
      { external_id: "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b", status: "created" },
      { external_id: "a7e1b9c0d2f34e5a8b6c7d8e9f0a1b2c", status: "updated" },
      { external_id: "0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e", status: "retracted" },
      {
        external_id: "f79e495bd37010e153bd2da07fd4eb22a248faa643887dffdd1d33e918e1c91c",
        status: "rejected",
        reason: "mycall_mismatch",
      },
    ],
  });
  assertEquals(rpcNames(r.calls), [
    "record_profile_lookup",
    "authenticate_relay_token",
    "record_relay_contacts",
    "apply_logged_contacts",
    "match_pending_spots",
  ]);
  assertEquals(rpcArgs(r.calls, "record_relay_contacts"), { p_token_id: "t-1", p_count: 4 });
  const args = rpcArgs(r.calls, "apply_logged_contacts");
  if (args === undefined) {
    throw new Error("apply_logged_contacts was not called");
  }
  assertEquals(args["p_user_id"], USER);
  const items = appliedItems(r.calls);
  assertEquals(items.map((i) => i["op"]), ["upsert", "upsert", "delete", "upsert"]);
  const first = items[0];
  if (first === undefined) {
    throw new Error("no items applied");
  }
  assertEquals(first["relay_version"], "0.1.0");
  const spot = first["spot"] as JsonObject;
  assertEquals(spot["source_spot_id"], `${USER}|4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b`);
  assertEquals(spot["spotter"], "KK4PWJ");
  assertEquals(spot["callsign"], "W1AW");
});

Deno.test("items rejected before the database never reach it, and keep their place", async function (): Promise<
  void
> {
  const contacts = [
    { external_id: "bad", op: "upsert", mycall: "KK4PWJ" },
    contactAt("old", "2026-10-28T20:00:00Z"),
    contactAt("ahead", "2026-10-28T21:40:00Z"),
    contactAt("fine", "2026-10-28T21:14:00Z"),
  ];
  const r = await run(post("/v1/contacts", { relay_version: "0.1.0", contacts }, AUTHED), {
    rpc: { apply_logged_contacts: applyAnswering({ fine: "unchanged" }) },
  }, KEY);
  assertEquals(r.res.status, 200);
  assertEquals((r.body as JsonObject)["results"], [
    { external_id: "bad", status: "rejected", reason: "invalid" },
    { external_id: "old", status: "rejected", reason: "too_old" },
    { external_id: "ahead", status: "rejected", reason: "clock_skew" },
    { external_id: "fine", status: "unchanged" },
  ]);
  assertEquals(appliedItems(r.calls).map((i) => i["external_id"]), ["fine"]);
  assertEquals(rpcNames(r.calls).includes("match_pending_spots"), false, "nothing new to match");
});

Deno.test("a batch with nothing to apply skips the database and the matcher", async function (): Promise<
  void
> {
  const contacts = [{ external_id: "bad", op: "replace" }];
  const r = await run(post("/v1/contacts", { relay_version: "0.1.0", contacts }, AUTHED), {}, KEY);
  assertEquals(r.res.status, 200);
  assertEquals(r.body, {
    results: [{ external_id: "bad", status: "rejected", reason: "invalid" }],
  });
  assertEquals(rpcNames(r.calls), [
    "record_profile_lookup",
    "authenticate_relay_token",
    "record_relay_contacts",
  ]);
});

Deno.test("an item the store would refuse is rejected as invalid, not the batch", async function (): Promise<
  void
> {
  // A user id this long takes source_spot_id past its bound, which assertStorableSpot refuses.
  const longUser = { token_id: "t-1", user_id: "u".repeat(300), scopes: ["contacts:write"] };
  const contacts = [contactAt("4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b", "2026-10-28T21:14:00Z")];
  const r = await run(post("/v1/contacts", { relay_version: "0.1.0", contacts }, AUTHED), {
    rpc: { authenticate_relay_token: { data: [longUser] } },
  }, KEY);
  assertEquals(r.res.status, 200);
  assertEquals(r.body, {
    results: [
      { external_id: "4f0d1c2b3a5e4d6f8a9b0c1d2e3f4a5b", status: "rejected", reason: "invalid" },
    ],
  });
  assertEquals(rpcNames(r.calls).includes("apply_logged_contacts"), false);
});

Deno.test("contacts refuses a request that breaks the request-level rules, applying nothing", async function (): Promise<
  void
> {
  const one = fixture.contacts[0];
  const bad: unknown[] = [
    { contacts: fixture.contacts },
    { relay_version: "", contacts: fixture.contacts },
    { relay_version: "0.1.0", contacts: [] },
    { relay_version: "0.1.0", contacts: Array(101).fill(one) },
    { relay_version: "0.1.0", contacts: [{ op: "delete" }] },
    { relay_version: "0.1.0", contacts: ["x"] },
    [one],
  ];
  for (const body of bad) {
    const r = await run(post("/v1/contacts", body, AUTHED), {}, KEY);
    assertEquals(r.res.status, 400);
    assertEquals(errorOf(r.body), "invalid_request");
    assertEquals(rpcNames(r.calls).includes("record_relay_contacts"), false);
  }
});

Deno.test("past 120 contacts a minute the request is 429 with the window's Retry-After", async function (): Promise<
  void
> {
  const r = await run(post("/v1/contacts", fixture, AUTHED), {
    rpc: { record_relay_contacts: { data: 17 } },
  }, KEY);
  assertEquals(r.res.status, 429);
  assertEquals(r.res.headers.get("Retry-After"), "17");
  assertEquals(errorOf(r.body), "rate_limited");
  assertEquals(rpcNames(r.calls).includes("apply_logged_contacts"), false);
});

Deno.test("a contact count that cannot be recorded is 500", async function (): Promise<void> {
  for (const answer of [{ error: { message: "down" } }, { data: -1 }]) {
    const r = await run(post("/v1/contacts", fixture, AUTHED), {
      rpc: { record_relay_contacts: answer },
    }, KEY);
    assertEquals(r.res.status, 500);
    assertEquals(r.body, { error: "server_error" });
  }
});

Deno.test("an apply the database refuses as bad input is 400, anything else 500", async function (): Promise<
  void
> {
  const cases: Array<[{ message: string; code: string }, number, string]> = [
    [{ message: "Not a logged contact item.", code: "22023" }, 400, "invalid_request"],
    [{ message: "deadlock", code: "40P01" }, 500, "server_error"],
  ];
  for (const entry of cases) {
    const r = await run(post("/v1/contacts", fixture, AUTHED), {
      rpc: { apply_logged_contacts: { error: entry[0] } },
    }, KEY);
    assertEquals(r.res.status, entry[1]);
    assertEquals(errorOf(r.body), entry[2]);
    assertEquals(rpcNames(r.calls).includes("match_pending_spots"), false);
  }
});

Deno.test("an apply reply that does not line up is 500", async function (): Promise<void> {
  for (
    const data of [
      [],
      [{ external_id: "other", status: "created" }],
      [{ external_id: "x", status: "maybe" }],
    ]
  ) {
    const r = await run(post("/v1/contacts", fixture, AUTHED), {
      rpc: { apply_logged_contacts: { data } },
    }, KEY);
    assertEquals(r.res.status, 500);
    assertEquals(r.body, { error: "server_error" });
  }
});

Deno.test("a matcher failure is logged and the batch still answers 200", async function (): Promise<
  void
> {
  let status = 0;
  let results: unknown = null;
  const logged = await capturingErrors(async function (): Promise<void> {
    const r = await run(post("/v1/contacts", fixture, AUTHED), {
      rpc: {
        apply_logged_contacts: applyAnswering({}),
        match_pending_spots: { error: { message: "matcher down" } },
      },
    }, KEY);
    status = r.res.status;
    results = (r.body as JsonObject)["results"];
  });
  assertEquals(status, 200);
  assertEquals((results as unknown[]).length, 4);
  assertEquals(logged.length, 1);
  assertStringIncludes(String(logged[0]), "relay-api: matcher failed");
});
