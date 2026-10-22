import { assertEquals } from "@std/assert";
import { errorStatus } from "../api/errors.ts";
import { apiToken, hashApiToken } from "../api/token.ts";

const TOKEN = `ll_live_${"7hq2abcd".repeat(6)}m4zk`;

function withAuth(value: string | null): Request {
  return new Request("http://x/", value === null ? {} : { headers: { Authorization: value } });
}

Deno.test("apiToken accepts only ll_live_ plus 52 base32 characters", () => {
  assertEquals(apiToken(withAuth(`Bearer ${TOKEN}`)), TOKEN);
  assertEquals(apiToken(withAuth(null)), null);
  assertEquals(apiToken(withAuth(`Bearer ${TOKEN.toUpperCase()}`)), null);
  assertEquals(apiToken(withAuth(`Bearer ${TOKEN}a`)), null);
  assertEquals(apiToken(withAuth(`Bearer ${TOKEN.slice(0, -1)}1`)), null);
  assertEquals(apiToken(withAuth(`Bearer ll_${"ab12".repeat(16)}`)), null);
  assertEquals(apiToken(withAuth("Bearer eyJhbGciOi.x.y")), null);
});

// The SHA-256 test vector; SQL stores encode(digest(token, 'sha256'), 'hex'), the same lowercase hex.
Deno.test("hashApiToken is lowercase hex SHA-256", async () => {
  assertEquals(
    await hashApiToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("errorStatus maps SQLSTATEs, not messages", () => {
  assertEquals(errorStatus({ code: "LL401", message: "Token not found." }), 401);
  assertEquals(errorStatus({ code: "LL403", message: "This token is read only." }), 403);
  assertEquals(errorStatus({ code: "LL404", message: "Group not found." }), 404);
  assertEquals(
    errorStatus({ code: "LL409", message: "Remove it from its connections first." }),
    409,
  );
  // A message alone decides nothing: a destination the body names but the caller doesn't own is a 400.
  assertEquals(errorStatus({ code: "P0001", message: "Destination not found." }), 400);
  assertEquals(
    errorStatus({ code: "P0001", message: "Remove it from its connections first." }),
    400,
  );
  assertEquals(errorStatus({ code: "22P02", message: "invalid input syntax for type uuid" }), 400);
  assertEquals(errorStatus({ code: "23514", message: "violates check constraint" }), 400);
  assertEquals(errorStatus({ code: "57014", message: "statement timeout" }), 500);
  assertEquals(errorStatus({ message: "network" }), 500);
});
