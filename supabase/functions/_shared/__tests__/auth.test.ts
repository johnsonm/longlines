import { assertEquals } from "@std/assert";
import { bearerToken, CRON_SECRET_HEADER, isServiceRole } from "../auth.ts";

Deno.test("bearerToken extracts the token from the Authorization header", function (): void {
  const req = new Request("http://x/", { headers: { Authorization: "Bearer abc.def.ghi" } });
  assertEquals(bearerToken(req), "abc.def.ghi");
});

Deno.test("bearerToken returns null when the header is missing or malformed", function (): void {
  assertEquals(bearerToken(new Request("http://x/")), null);
  assertEquals(
    bearerToken(new Request("http://x/", { headers: { Authorization: "Basic xyz" } })),
    null,
  );
  assertEquals(
    bearerToken(new Request("http://x/", { headers: { Authorization: "Bearer " } })),
    null,
  );
});

/** An unsigned JWT-shaped token; the gateway (verify_jwt) checks signatures, not isServiceRole. */
function jwt(payload: Record<string, unknown>): string {
  function b64url(o: unknown): string {
    return btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  }
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.signature`;
}
function withBearer(token: string | undefined): Request {
  let headers: Record<string, string> = {};
  if (token) {
    headers = { Authorization: `Bearer ${token}` };
  }
  return new Request("http://x/", { headers });
}

Deno.test("isServiceRole accepts the runtime key itself", async function (): Promise<void> {
  assertEquals(await isServiceRole(withBearer("sb_secret_abc"), "sb_secret_abc", undefined), true);
});

Deno.test(
  "isServiceRole accepts a service_role JWT when the runtime key is the new secret key",
  async function (): Promise<void> {
    // Hosted projects set SUPABASE_SERVICE_ROLE_KEY to sb_secret_..., while pg_cron must send the
    // legacy service-role JWT to get past verify_jwt.
    assertEquals(
      await isServiceRole(withBearer(jwt({ role: "service_role" })), "sb_secret_abc", undefined),
      true,
    );
    assertEquals(
      await isServiceRole(withBearer(jwt({ role: "service_role" })), undefined, undefined),
      true,
    );
  },
);

Deno.test(
  "isServiceRole refuses other roles, other tokens and a missing header",
  async function (): Promise<void> {
    assertEquals(
      await isServiceRole(
        withBearer(jwt({ role: "authenticated", sub: "u1" })),
        "sb_secret_abc",
        undefined,
      ),
      false,
    );
    assertEquals(
      await isServiceRole(withBearer(jwt({ role: "anon" })), "sb_secret_abc", undefined),
      false,
    );
    assertEquals(
      await isServiceRole(withBearer("sb_secret_other"), "sb_secret_abc", undefined),
      false,
    );
    assertEquals(await isServiceRole(withBearer("a.%%%.c"), "sb_secret_abc", undefined), false);
    assertEquals(await isServiceRole(withBearer("only.two"), "sb_secret_abc", undefined), false);
    assertEquals(await isServiceRole(withBearer(undefined), "sb_secret_abc", undefined), false);
    assertEquals(await isServiceRole(withBearer(undefined), undefined, undefined), false);
  },
);

Deno.test(
  "isServiceRole reads the role only from a base64url JSON object payload",
  async function (): Promise<void> {
    const payload = btoa(JSON.stringify({ role: "service_role" }));
    // Padding is tolerated at the end, as atob tolerated it.
    assertEquals(payload.endsWith("="), true);
    assertEquals(await isServiceRole(withBearer(`h.${payload}.s`), undefined, undefined), true);
    for (
      const middle of [
        "a",
        "ab=c",
        btoa("not json"),
        btoa(JSON.stringify("service_role")),
        btoa(JSON.stringify(null)),
        btoa(JSON.stringify({ role: 5 })),
      ]
    ) {
      assertEquals(
        await isServiceRole(withBearer(`h.${middle}.s`), undefined, undefined),
        false,
        middle,
      );
    }
  },
);

/** A request as cron_call_function sends it: the anon JWT as the bearer, plus the cron secret. */
function fromCron(secret: string | undefined): Request {
  const headers: Record<string, string> = { Authorization: `Bearer ${jwt({ role: "anon" })}` };
  if (secret !== undefined) {
    headers[CRON_SECRET_HEADER] = secret;
  }
  return new Request("http://x/", { headers });
}

Deno.test("isServiceRole accepts pg_cron's x-cron-secret", async function (): Promise<void> {
  assertEquals(CRON_SECRET_HEADER, "x-cron-secret");
  assertEquals(await isServiceRole(fromCron("cron-abc"), "sb_secret_abc", "cron-abc"), true);
  assertEquals(await isServiceRole(fromCron("cron-abc"), undefined, "cron-abc"), true);
});

Deno.test(
  "isServiceRole refuses a wrong, empty or missing cron secret, and any when none is configured",
  async function (): Promise<void> {
    assertEquals(await isServiceRole(fromCron("cron-other"), "sb_secret_abc", "cron-abc"), false);
    assertEquals(await isServiceRole(fromCron(""), "sb_secret_abc", "cron-abc"), false);
    assertEquals(await isServiceRole(fromCron(undefined), "sb_secret_abc", "cron-abc"), false);
    assertEquals(await isServiceRole(fromCron("cron-abc"), "sb_secret_abc", undefined), false);
    assertEquals(await isServiceRole(fromCron(""), "sb_secret_abc", ""), false);
    // The bearer paths still work with a cron secret configured, for manual calls and the rollout.
    assertEquals(
      await isServiceRole(withBearer("sb_secret_abc"), "sb_secret_abc", "cron-abc"),
      true,
    );
    assertEquals(
      await isServiceRole(withBearer(jwt({ role: "service_role" })), undefined, "cron-abc"),
      true,
    );
  },
);
