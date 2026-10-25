import { assertEquals } from "@std/assert";
import { bearerToken, isServiceRole } from "../auth.ts";

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
  assertEquals(await isServiceRole(withBearer("sb_secret_abc"), "sb_secret_abc"), true);
});

Deno.test(
  "isServiceRole accepts a service_role JWT when the runtime key is the new secret key",
  async function (): Promise<void> {
    // Hosted projects set SUPABASE_SERVICE_ROLE_KEY to sb_secret_..., while pg_cron must send the
    // legacy service-role JWT to get past verify_jwt.
    assertEquals(
      await isServiceRole(withBearer(jwt({ role: "service_role" })), "sb_secret_abc"),
      true,
    );
    assertEquals(await isServiceRole(withBearer(jwt({ role: "service_role" })), undefined), true);
  },
);

Deno.test(
  "isServiceRole refuses other roles, other tokens and a missing header",
  async function (): Promise<void> {
    assertEquals(
      await isServiceRole(withBearer(jwt({ role: "authenticated", sub: "u1" })), "sb_secret_abc"),
      false,
    );
    assertEquals(await isServiceRole(withBearer(jwt({ role: "anon" })), "sb_secret_abc"), false);
    assertEquals(await isServiceRole(withBearer("sb_secret_other"), "sb_secret_abc"), false);
    assertEquals(await isServiceRole(withBearer("a.%%%.c"), "sb_secret_abc"), false);
    assertEquals(await isServiceRole(withBearer("only.two"), "sb_secret_abc"), false);
    assertEquals(await isServiceRole(withBearer(undefined), "sb_secret_abc"), false);
    assertEquals(await isServiceRole(withBearer(undefined), undefined), false);
  },
);
