import { assertEquals } from "@std/assert";
import { hashApiToken } from "../api/token.ts";
import { bearerToken } from "../bearer.ts";
import {
  RELAY_TOKEN_PATTERN,
  relayToken,
  type RelayTokenRow,
  relayTokenRowsSchema,
  SPOTS_READ,
} from "../relay_token.ts";

const TOKEN = `ll_relay_${"a".repeat(50)}27`;

function withAuthorization(value: string | null): Request {
  const headers: Record<string, string> = {};
  if (value !== null) {
    headers.Authorization = value;
  }
  return new Request("http://x/", { headers });
}

Deno.test("relayToken takes only a bearer token of the contract's shape", function (): void {
  assertEquals(relayToken(withAuthorization(`Bearer ${TOKEN}`)), TOKEN);
  assertEquals(relayToken(withAuthorization(`bearer ${TOKEN}`)), TOKEN);
  for (
    const bad of [
      null,
      "",
      TOKEN,
      `Basic ${TOKEN}`,
      `Bearer ${TOKEN}a`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN.toUpperCase()}`,
      `Bearer ll_live_${"a".repeat(52)}`,
      `Bearer ll_relay_${"1".repeat(52)}`,
    ]
  ) {
    assertEquals(relayToken(withAuthorization(bad)), null, String(bad));
  }
  assertEquals(RELAY_TOKEN_PATTERN.test(TOKEN), true);
  assertEquals(TOKEN.length, 61);
  assertEquals(bearerToken(withAuthorization(`Bearer ${TOKEN}`)), TOKEN);
});

Deno.test("a relay token is matched by its SHA-256, like an API token", async function () {
  assertEquals(
    await hashApiToken("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("authenticate_relay_token's rows parse loose; none is null or empty", function (): void {
  assertEquals(
    relayTokenRowsSchema.parse([{
      token_id: "t",
      user_id: "u",
      scopes: [SPOTS_READ],
      extra: 1,
    }]),
    [{ token_id: "t", user_id: "u", scopes: ["spots:read"], extra: 1 } as RelayTokenRow],
  );
  assertEquals(relayTokenRowsSchema.parse(null), null);
  assertEquals(
    relayTokenRowsSchema.safeParse([{ token_id: "t" }]).success,
    false,
  );
});
