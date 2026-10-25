import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  EMAIL_NOT_CONFIRMED,
  FAILED_SIGN_IN_FLOOR_MS,
  handleSignIn,
  SIGN_IN_UNAVAILABLE,
} from "../handlers/sign_in.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";
import { GENERIC_SIGN_IN_ERROR, TOO_MANY_ATTEMPTS } from "../signin.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

const KEY = await hmacKey("test-service-role-key");

const CLIENT_IP: Record<string, string> = { "cf-connecting-ip": "192.0.2.7" };

function post(
  body: unknown,
  headers: Record<string, string>,
) {
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    text = JSON.stringify(body);
  }
  return new Request("http://x/", {
    method: "POST",
    headers,
    body: text,
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

interface RunDeps {
  key?: CryptoKey | undefined;
  clientIpHeader?: string;
  elapsedMs?: number;
}

const DEPS: RunDeps = { key: KEY };

async function run(
  req: Request,
  admin: FakeSupabaseOptions,
  anon: FakeSupabaseOptions,
  deps: RunDeps,
) {
  const a = fakeSupabase({
    rpc: Object.assign({
      begin_sign_in_attempt: { data: 41 },
      forget_sign_in_attempt: { data: null },
      email_for_identifier: { data: "kk4pwj@example.com" },
    }, admin.rpc),
  });
  const b = fakeSupabase(anon);
  // A fake clock: the request takes `elapsedMs` (default 0) and sleeps are recorded, not waited.
  let now = 1_000;
  let first = true;
  const sleeps: number[] = [];
  function clock(): number {
    if (first) {
      first = false;
    } else {
      let elapsed = 0;
      if (deps.elapsedMs !== undefined) {
        elapsed = deps.elapsedMs;
      }
      now = 1_000 + elapsed;
    }
    return now;
  }
  const res = await handleSignIn(req, {
    admin: () => a.client,
    anon: () => b.client,
    clientIpHeader: deps.clientIpHeader,
    key: deps.key,
    clock,
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
  });
  let body = null;
  if (res.status !== 204) {
    body = await res.json();
  }
  return {
    res,
    body,
    admin: a.calls,
    anon: b.calls,
    sleeps,
  };
}

function fns(calls: { rpc: Array<{ fn: string }> }) {
  return calls.rpc.map((c) => c.fn);
}

Deno.test(
  "handleSignIn answers preflight and rejects other methods",
  async function (): Promise<void> {
    const pre = await run(new Request("http://x/", { method: "OPTIONS" }), {}, {}, DEPS);
    assertEquals(pre.res.status, 204);
    const get = await run(new Request("http://x/"), {}, {}, DEPS);
    assertEquals(get.res.status, 405);
    assertEquals(get.admin.rpc, []);
  },
);

Deno.test("handleSignIn rejects malformed and oversized bodies", async function (): Promise<void> {
  assertEquals((await run(post("not json", CLIENT_IP), {}, {}, DEPS)).res.status, 400);
  const missing = await run(post({ identifier: "x" }, CLIENT_IP), {}, {}, DEPS);
  assertEquals(missing.res.status, 400);
  assertEquals(missing.body, { error: "Send an identifier and a password." });
  const long = await run(
    post({ identifier: `${"a".repeat(250)}@b.cd`, password: "x" }, CLIENT_IP),
    {},
    {},
    DEPS,
  );
  assertEquals(long.res.status, 400);
  assertEquals(long.admin.rpc, []);
  const bigPassword = await run(
    post({ identifier: "kk4pwj", password: "x".repeat(1025) }, CLIENT_IP),
    {},
    {},
    DEPS,
  );
  assertEquals(bigPassword.res.status, 400);
});

Deno.test(
  "handleSignIn returns tokens and forgets the attempt for a right password",
  async function (): Promise<void> {
    const ran = await run(post(GOOD, CLIENT_IP), {}, { signInWithPassword: SESSION }, DEPS);
    const res = ran.res;
    const body = ran.body;
    const admin = ran.admin;
    const anon = ran.anon;
    assertEquals(res.status, 200);
    assertEquals(body, { access_token: "at", refresh_token: "rt", expires_in: 3600 });
    assertEquals(fns(admin), [
      "email_for_identifier",
      "begin_sign_in_attempt",
      "forget_sign_in_attempt",
    ]);
    assertEquals(admin.rpc[0]!.args, { p_identifier: "KK4PWJ" });
    // The attempt is keyed on the account's email, not the callsign typed.
    assertEquals(admin.rpc[1]!.args, {
      p_identifier: "kk4pwj@example.com",
      p_client: await hmacSha256Hex(KEY, "192.0.2.7"),
    });
    assertEquals(admin.rpc[2]!.args, { p_attempt_id: 41 });
    assertEquals(anon.signInWithPassword, [{ email: "kk4pwj@example.com", password: "hunter22" }]);
  },
);

Deno.test(
  "handleSignIn keys attempts on the client, from the configured header",
  async function (): Promise<void> {
    const one = await run(post(GOOD, { "x-real-ip": "198.51.100.1" }), {}, WRONG, {
      key: KEY,
      clientIpHeader: "x-real-ip",
    });
    const two = await run(post(GOOD, { "x-real-ip": "198.51.100.2" }), {}, WRONG, {
      key: KEY,
      clientIpHeader: "x-real-ip",
    });
    function clientOf(r: typeof one) {
      return r.admin.rpc[1]!.args!["p_client"];
    }
    assertEquals(clientOf(one), await hmacSha256Hex(KEY, "198.51.100.1"));
    assertNotEquals(clientOf(one), clientOf(two));
  },
);

Deno.test(
  "handleSignIn counts a wrong password and keeps it logged",
  async function (): Promise<void> {
    const ran = await run(post(GOOD, CLIENT_IP), {}, WRONG, DEPS);
    const res = ran.res;
    const body = ran.body;
    const admin = ran.admin;
    assertEquals(res.status, 401);
    assertEquals(body, { error: GENERIC_SIGN_IN_ERROR });
    assertEquals(fns(admin), ["email_for_identifier", "begin_sign_in_attempt"]);
  },
);

Deno.test(
  "handleSignIn gives an account's email and callsign one attempt budget",
  async function (): Promise<void> {
    function keyOf(r: Awaited<ReturnType<typeof run>>) {
      return r.admin.rpc[1]!.args!["p_identifier"];
    }
    const byCall = await run(post(GOOD, CLIENT_IP), {}, WRONG, DEPS);
    const byEmail = await run(
      post({ identifier: "KK4PWJ@Example.com", password: "x" }, CLIENT_IP),
      {
        rpc: { email_for_identifier: { data: "KK4PWJ@example.com" } },
      },
      WRONG,
      DEPS,
    );
    assertEquals(byEmail.admin.rpc[0]!.args, { p_identifier: "kk4pwj@example.com" });
    assertEquals([keyOf(byCall), keyOf(byEmail)], ["kk4pwj@example.com", "kk4pwj@example.com"]);
    // A callsign with no account is counted as typed.
    const unknown = await run(
      post(GOOD, CLIENT_IP),
      { rpc: { email_for_identifier: { data: null } } },
      WRONG,
      DEPS,
    );
    assertEquals(keyOf(unknown), "KK4PWJ");
  },
);

Deno.test(
  "handleSignIn holds a wrong password's answer to the floor from the request's start",
  async function (): Promise<void> {
    const fast = await run(post(GOOD, CLIENT_IP), {}, WRONG, { key: KEY, elapsedMs: 40 });
    assertEquals(fast.res.status, 401);
    assertEquals(fast.sleeps, [FAILED_SIGN_IN_FLOOR_MS - 40]);
    const slow = await run(post(GOOD, CLIENT_IP), {}, WRONG, { key: KEY, elapsedMs: 500 });
    assertEquals(slow.res.status, 401);
    assertEquals(slow.sleeps, []);
    // Only a 401 waits: a right password or a refusal answers at once.
    const ok = await run(post(GOOD, CLIENT_IP), {}, { signInWithPassword: SESSION }, DEPS);
    assertEquals([ok.res.status, ok.sleeps], [200, []]);
    const refused = await run(
      post(GOOD, CLIENT_IP),
      { rpc: { begin_sign_in_attempt: { data: null } } },
      {},
      DEPS,
    );
    assertEquals([refused.res.status, refused.sleeps], [429, []]);
  },
);

Deno.test(
  "handleSignIn waits the real floor with the default clock",
  async function (): Promise<void> {
    const a = fakeSupabase({
      rpc: {
        begin_sign_in_attempt: { data: 41 },
        email_for_identifier: { data: "kk4pwj@example.com" },
      },
    });
    const b = fakeSupabase(WRONG);
    const started = performance.now();
    const res = await handleSignIn(post(GOOD, CLIENT_IP), {
      admin: () => a.client,
      anon: () => b.client,
      clientIpHeader: undefined,
      key: KEY,
    });
    assertEquals(res.status, 401);
    if (res.body !== null && res.body !== undefined) {
      await res.body.cancel();
    }
    assert(performance.now() - started >= FAILED_SIGN_IN_FLOOR_MS - 5);
  },
);

Deno.test(
  "handleSignIn still checks a password for unknown identifiers",
  async function (): Promise<void> {
    const ran = await run(
      post(GOOD, CLIENT_IP),
      {
        rpc: { email_for_identifier: { data: null } },
      },
      WRONG,
      DEPS,
    );
    const res = ran.res;
    const body = ran.body;
    const anon = ran.anon;
    assertEquals(res.status, 401);
    assertEquals(body, { error: GENERIC_SIGN_IN_ERROR });
    assertMatch(anon.signInWithPassword[0]!.email, /^unknown-.+@invalid$/);
  },
);

Deno.test(
  "handleSignIn explains unconfirmed emails without counting them",
  async function (): Promise<void> {
    const ran = await run(post(GOOD, CLIENT_IP), {}, {
      signInWithPassword: { error: { message: "x", code: "email_not_confirmed" } },
    }, DEPS);
    const res = ran.res;
    const body = ran.body;
    const admin = ran.admin;
    assertEquals(res.status, 403);
    assertEquals(body, { error: EMAIL_NOT_CONFIRMED });
    assertEquals(fns(admin).at(-1), "forget_sign_in_attempt");
  },
);

Deno.test(
  "handleSignIn rate limits a refused attempt without checking the password",
  async function (): Promise<void> {
    const ran = await run(
      post(GOOD, CLIENT_IP),
      {
        rpc: { begin_sign_in_attempt: { data: null } },
      },
      {},
      DEPS,
    );
    const res = ran.res;
    const body = ran.body;
    const anon = ran.anon;
    const admin = ran.admin;
    assertEquals(res.status, 429);
    assertEquals(body, { error: TOO_MANY_ATTEMPTS });
    assertEquals(anon.signInWithPassword, []);
    assertEquals(fns(admin), ["email_for_identifier", "begin_sign_in_attempt"]);
  },
);

Deno.test(
  "handleSignIn maps Auth's own rate limit to 429 without counting it",
  async function (): Promise<void> {
    for (
      const error of [
        { message: "Request rate limit reached", code: "over_request_rate_limit", status: 429 },
        { message: "Too many requests", status: 429 },
      ]
    ) {
      const ran = await run(post(GOOD, CLIENT_IP), {}, { signInWithPassword: { error } }, DEPS);
      const res = ran.res;
      const body = ran.body;
      const admin = ran.admin;
      assertEquals(res.status, 429);
      assertEquals(body, { error: TOO_MANY_ATTEMPTS });
      assertEquals(fns(admin).at(-1), "forget_sign_in_attempt");
    }
  },
);

Deno.test(
  "handleSignIn reports other Auth failures as unavailable and logs them",
  async function (): Promise<void> {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args[0]);
    try {
      const down = await run(post(GOOD, CLIENT_IP), {}, {
        signInWithPassword: {
          error: { message: "upstream", code: "unexpected_failure", status: 500 },
        },
      }, DEPS);
      assertEquals(down.res.status, 500);
      assertEquals(down.body, { error: SIGN_IN_UNAVAILABLE });
      assertEquals(fns(down.admin).at(-1), "forget_sign_in_attempt");

      const noSession = await run(post(GOOD, CLIENT_IP), {}, {
        signInWithPassword: { data: { session: null } },
      }, DEPS);
      assertEquals(noSession.res.status, 500);

      const forgetFails = await run(
        post(GOOD, CLIENT_IP),
        {
          rpc: { forget_sign_in_attempt: { error: { message: "gone" } } },
        },
        { signInWithPassword: SESSION },
        DEPS,
      );
      assertEquals(forgetFails.res.status, 200);
    } finally {
      console.error = original;
    }
    assertMatch(String(errors[0]), /unexpected_failure: upstream/);
    assertMatch(String(errors[1]), /no session/);
    assertMatch(String(errors[2]), /forgetting an attempt failed: gone/);
  },
);

Deno.test(
  "handleSignIn returns 500 when the key, attempt log or lookup fails",
  async function (): Promise<void> {
    const noKey = await run(post(GOOD, CLIENT_IP), {}, {}, { key: undefined });
    assertEquals(noKey.res.status, 500);
    assertEquals(noKey.admin.rpc, []);

    const log = await run(
      post(GOOD, CLIENT_IP),
      {
        rpc: { begin_sign_in_attempt: { error: { message: "down" } } },
      },
      {},
      DEPS,
    );
    assertEquals(log.res.status, 500);
    assertEquals(log.body, { error: SIGN_IN_UNAVAILABLE });

    const lookup = await run(
      post(GOOD, CLIENT_IP),
      {
        rpc: { email_for_identifier: { error: { message: "down" } } },
      },
      {},
      DEPS,
    );
    assertEquals(lookup.res.status, 500);
    assert(lookup.anon.signInWithPassword.length === 0);
    // The lookup comes first, so there is no attempt to forget.
    assertEquals(fns(lookup.admin), ["email_for_identifier"]);
  },
);
