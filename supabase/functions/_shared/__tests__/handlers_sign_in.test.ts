import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { EMAIL_NOT_CONFIRMED, handleSignIn, SIGN_IN_UNAVAILABLE } from "../handlers/sign_in.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import { GENERIC_SIGN_IN_ERROR, TOO_MANY_ATTEMPTS } from "../signin.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const KEY = await hmacKey("test-service-role-key");

function post(
  body: unknown,
  headers: Record<string, string> = { "cf-connecting-ip": "192.0.2.7" },
) {
  return new Request("http://x/", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const GOOD = { identifier: " kk4pwj ", password: "hunter22" };
const SESSION = {
  data: { session: { access_token: "at", refresh_token: "rt", expires_in: 3600 } },
};
const WRONG: FakeSupabaseOptions = {
  signInWithPassword: {
    error: { message: "Invalid login credentials", code: "invalid_credentials" },
  },
};

async function run(
  req: Request,
  admin: FakeSupabaseOptions = {},
  anon: FakeSupabaseOptions = {},
  deps: { key?: CryptoKey | undefined; clientIpHeader?: string } = { key: KEY },
) {
  const a = fakeSupabase({
    rpc: {
      begin_sign_in_attempt: { data: 41 },
      forget_sign_in_attempt: { data: null },
      email_for_identifier: { data: "kk4pwj@example.com" },
      ...admin.rpc,
    },
  });
  const b = fakeSupabase(anon);
  const res = await handleSignIn(req, {
    admin: () => a.client,
    anon: () => b.client,
    clientIpHeader: deps.clientIpHeader,
    key: deps.key,
  });
  return { res, body: res.status === 204 ? null : await res.json(), admin: a.calls, anon: b.calls };
}

const fns = (calls: { rpc: Array<{ fn: string }> }) => calls.rpc.map((c) => c.fn);

Deno.test("handleSignIn answers preflight and rejects other methods", async () => {
  const pre = await run(new Request("http://x/", { method: "OPTIONS" }));
  assertEquals(pre.res.status, 204);
  const get = await run(new Request("http://x/"));
  assertEquals(get.res.status, 405);
  assertEquals(get.admin.rpc, []);
});

Deno.test("handleSignIn rejects malformed and oversized bodies", async () => {
  assertEquals((await run(post("not json"))).res.status, 400);
  const missing = await run(post({ identifier: "x" }));
  assertEquals(missing.res.status, 400);
  assertEquals(missing.body, { error: "Send an identifier and a password." });
  const long = await run(post({ identifier: `${"a".repeat(250)}@b.cd`, password: "x" }));
  assertEquals(long.res.status, 400);
  assertEquals(long.admin.rpc, []);
  const bigPassword = await run(post({ identifier: "kk4pwj", password: "x".repeat(1025) }));
  assertEquals(bigPassword.res.status, 400);
});

Deno.test("handleSignIn returns tokens and forgets the attempt for a right password", async () => {
  const { res, body, admin, anon } = await run(post(GOOD), {}, { signInWithPassword: SESSION });
  assertEquals(res.status, 200);
  assertEquals(body, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
  assertEquals(fns(admin), [
    "begin_sign_in_attempt",
    "email_for_identifier",
    "forget_sign_in_attempt",
  ]);
  assertEquals(admin.rpc[0]!.args, {
    p_identifier: "KK4PWJ",
    p_client: await hmacSha256Hex(KEY, "192.0.2.7"),
  });
  assertEquals(admin.rpc[1]!.args, { p_identifier: "KK4PWJ" });
  assertEquals(admin.rpc[2]!.args, { p_attempt_id: 41 });
  assertEquals(anon.signInWithPassword, [{ email: "kk4pwj@example.com", password: "hunter22" }]);
});

Deno.test("handleSignIn keys attempts on the client, from the configured header", async () => {
  const one = await run(post(GOOD, { "x-real-ip": "198.51.100.1" }), {}, WRONG, {
    key: KEY,
    clientIpHeader: "x-real-ip",
  });
  const two = await run(post(GOOD, { "x-real-ip": "198.51.100.2" }), {}, WRONG, {
    key: KEY,
    clientIpHeader: "x-real-ip",
  });
  const clientOf = (r: typeof one) => r.admin.rpc[0]!.args!["p_client"];
  assertEquals(clientOf(one), await hmacSha256Hex(KEY, "198.51.100.1"));
  assertNotEquals(clientOf(one), clientOf(two));
});

Deno.test("handleSignIn counts a wrong password and keeps it logged", async () => {
  const { res, body, admin } = await run(post(GOOD), {}, WRONG);
  assertEquals(res.status, 401);
  assertEquals(body, { error: GENERIC_SIGN_IN_ERROR });
  assertEquals(fns(admin), ["begin_sign_in_attempt", "email_for_identifier"]);
});

Deno.test("handleSignIn still checks a password for unknown identifiers", async () => {
  const { res, body, anon } = await run(post(GOOD), {
    rpc: { email_for_identifier: { data: null } },
  }, WRONG);
  assertEquals(res.status, 401);
  assertEquals(body, { error: GENERIC_SIGN_IN_ERROR });
  assertMatch(anon.signInWithPassword[0]!.email, /^unknown-.+@invalid$/);
});

Deno.test("handleSignIn explains unconfirmed emails without counting them", async () => {
  const { res, body, admin } = await run(post(GOOD), {}, {
    signInWithPassword: { error: { message: "x", code: "email_not_confirmed" } },
  });
  assertEquals(res.status, 403);
  assertEquals(body, { error: EMAIL_NOT_CONFIRMED });
  assertEquals(fns(admin).at(-1), "forget_sign_in_attempt");
});

Deno.test("handleSignIn rate limits a refused attempt without checking the password", async () => {
  const { res, body, anon, admin } = await run(post(GOOD), {
    rpc: { begin_sign_in_attempt: { data: null } },
  });
  assertEquals(res.status, 429);
  assertEquals(body, { error: TOO_MANY_ATTEMPTS });
  assertEquals(anon.signInWithPassword, []);
  assertEquals(fns(admin), ["begin_sign_in_attempt"]);
});

Deno.test("handleSignIn maps Auth's own rate limit to 429 without counting it", async () => {
  for (
    const error of [
      { message: "Request rate limit reached", code: "over_request_rate_limit", status: 429 },
      { message: "Too many requests", status: 429 },
    ]
  ) {
    const { res, body, admin } = await run(post(GOOD), {}, { signInWithPassword: { error } });
    assertEquals(res.status, 429);
    assertEquals(body, { error: TOO_MANY_ATTEMPTS });
    assertEquals(fns(admin).at(-1), "forget_sign_in_attempt");
  }
});

Deno.test("handleSignIn reports other Auth failures as unavailable and logs them", async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args[0]);
  try {
    const down = await run(post(GOOD), {}, {
      signInWithPassword: {
        error: { message: "upstream", code: "unexpected_failure", status: 500 },
      },
    });
    assertEquals(down.res.status, 500);
    assertEquals(down.body, { error: SIGN_IN_UNAVAILABLE });
    assertEquals(fns(down.admin).at(-1), "forget_sign_in_attempt");

    const noSession = await run(post(GOOD), {}, {
      signInWithPassword: { data: { session: null } },
    });
    assertEquals(noSession.res.status, 500);

    const forgetFails = await run(post(GOOD), {
      rpc: { forget_sign_in_attempt: { error: { message: "gone" } } },
    }, { signInWithPassword: SESSION });
    assertEquals(forgetFails.res.status, 200);
  } finally {
    console.error = original;
  }
  assertMatch(String(errors[0]), /unexpected_failure: upstream/);
  assertMatch(String(errors[1]), /no session/);
  assertMatch(String(errors[2]), /forgetting an attempt failed: gone/);
});

Deno.test("handleSignIn returns 500 when the key, attempt log or lookup fails", async () => {
  const noKey = await run(post(GOOD), {}, {}, { key: undefined });
  assertEquals(noKey.res.status, 500);
  assertEquals(noKey.admin.rpc, []);

  const log = await run(post(GOOD), {
    rpc: { begin_sign_in_attempt: { error: { message: "down" } } },
  });
  assertEquals(log.res.status, 500);
  assertEquals(log.body, { error: SIGN_IN_UNAVAILABLE });

  const lookup = await run(post(GOOD), {
    rpc: { email_for_identifier: { error: { message: "down" } } },
  });
  assertEquals(lookup.res.status, 500);
  assert(lookup.anon.signInWithPassword.length === 0);
  assertEquals(fns(lookup.admin).at(-1), "forget_sign_in_attempt");
});
