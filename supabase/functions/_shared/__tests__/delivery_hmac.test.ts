import { assertEquals } from "@std/assert";
import { signWebhookBody } from "../delivery/hmac.ts";
import { hmacKey, hmacSha256Hex } from "../hmac.ts";

Deno.test("signWebhookBody is sha256= plus the HMAC of timestamp.body", async () => {
  // printf '1700000000.{"deliveries":[]}' | openssl dgst -sha256 -hmac 'whsec_testsecret'
  assertEquals(
    await signWebhookBody("whsec_testsecret", 1700000000, '{"deliveries":[]}'),
    "sha256=06ba5480df63d14e867f6a22613f245bf89acfc96d00361e0243ede01708e5b3",
  );
});

Deno.test("signWebhookBody changes with the timestamp", async () => {
  const a = await signWebhookBody("whsec_testsecret", 1, "{}");
  const b = await signWebhookBody("whsec_testsecret", 2, "{}");
  assertEquals(a === b, false);
});

Deno.test("hmacSha256Hex is the RFC 4231 HMAC-SHA-256", async () => {
  // RFC 4231 test case 2.
  assertEquals(
    await hmacSha256Hex(await hmacKey("Jefe"), "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});
