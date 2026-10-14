import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
  generateVapidKeys,
  vapidAuthorization,
  vapidKeysFromEnv,
} from "../delivery/webpush.ts";

// RFC 8291 Section 5 and Appendix A, with the whitespace removed. If this
// test fails, fix the code, never the vector.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

// A VAPID keypair made for these tests only.
async function testVapid() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    pair,
    keys: {
      publicKey: base64UrlEncode(raw),
      privateKey: jwk.d ?? "",
      subject: "mailto:ops@longlines.io",
    },
    jwk,
  };
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

Deno.test("base64url round-trips bytes without padding and accepts padded input", () => {
  const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x01]);
  assertEquals(base64UrlEncode(bytes), "-__-AAE");
  assertEquals(base64UrlDecode("-__-AAE"), bytes);
  assertEquals(base64UrlDecode("-__-AAE="), bytes);
  assertEquals(base64UrlDecode(""), new Uint8Array());
});

Deno.test("encryptPushPayload reproduces the RFC 8291 Appendix A vector byte for byte", async () => {
  const body = await encryptPushPayload(
    new TextEncoder().encode(RFC.plaintext),
    { p256dh: RFC.uaPublic, auth: RFC.authSecret },
    {
      serverKey: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
      salt: base64UrlDecode(RFC.salt),
    },
  );
  assertEquals(base64UrlEncode(body), RFC.body);
});

Deno.test("encryptPushPayload uses a fresh key and salt by default", async () => {
  const plaintext = new TextEncoder().encode(RFC.plaintext);
  const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
  const a = await encryptPushPayload(plaintext, keys);
  const b = await encryptPushPayload(plaintext, keys);
  // salt(16) + rs(4) + idlen(1) + key(65) + plaintext + delimiter + tag(16)
  assertEquals(a.length, 86 + plaintext.length + 1 + 16);
  assertEquals(new DataView(a.buffer).getUint32(16), 4096);
  assertEquals(a[20], 65);
  assert(base64UrlEncode(a.slice(0, 16)) !== base64UrlEncode(b.slice(0, 16)), "salt repeats");
  assert(base64UrlEncode(a.slice(21, 86)) !== base64UrlEncode(b.slice(21, 86)), "key repeats");
});

Deno.test("encryptPushPayload rejects subscription keys of the wrong size", async () => {
  const plaintext = new TextEncoder().encode("x");
  await assertRejects(
    () => encryptPushPayload(plaintext, { p256dh: RFC.uaPublic, auth: "AAAA" }),
    Error,
    "auth",
  );
  await assertRejects(
    () => encryptPushPayload(plaintext, { p256dh: "AAAA", auth: RFC.authSecret }),
    Error,
    "p256dh",
  );
});

Deno.test("vapidAuthorization signs an ES256 JWT for the endpoint's origin", async () => {
  const { pair, keys } = await testVapid();
  const now = new Date("2026-10-13T12:00:00Z");
  const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, now);

  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert(match, header);
  const [, jwt, k] = match;
  assertEquals(k, keys.publicKey);

  const [h, p, s] = jwt!.split(".");
  assertEquals(decodeJson(h!), { typ: "JWT", alg: "ES256" });
  const claims = decodeJson(p!);
  assertEquals(claims.aud, "https://fcm.googleapis.com");
  assertEquals(claims.sub, "mailto:ops@longlines.io");
  assertEquals(claims.exp, now.getTime() / 1000 + 12 * 60 * 60);

  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    base64UrlDecode(s!),
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert(verified, "signature does not verify with the public key");
});

Deno.test("vapidAuthorization accepts the private key as a JWK", async () => {
  const { pair, keys, jwk } = await testVapid();
  const header = await vapidAuthorization(
    "https://web.push.apple.com/QGuQ",
    { ...keys, privateKey: JSON.stringify(jwk) },
    new Date(),
  );
  const jwt = /t=([^,]+),/.exec(header)![1]!;
  const [h, p, s] = jwt.split(".");
  assertEquals(decodeJson(p!).aud, "https://web.push.apple.com");
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      base64UrlDecode(s!),
      new TextEncoder().encode(`${h}.${p}`),
    ),
  );
});

Deno.test("vapidKeysFromEnv needs all three values", () => {
  const env: Record<string, string> = {
    LONGLINES_VAPID_PUBLIC_KEY: "pub",
    LONGLINES_VAPID_PRIVATE_KEY: "priv",
    LONGLINES_VAPID_SUBJECT: "mailto:ops@longlines.io",
  };
  assertEquals(vapidKeysFromEnv((k) => env[k]), {
    publicKey: "pub",
    privateKey: "priv",
    subject: "mailto:ops@longlines.io",
  });
  for (const missing of Object.keys(env)) {
    const partial = { ...env, [missing]: " " };
    assertEquals(vapidKeysFromEnv((k) => partial[k]), undefined, missing);
  }
});

Deno.test("generateVapidKeys makes a pair that signs a verifiable JWT", async () => {
  const keys = await generateVapidKeys("mailto:ops@longlines.io");
  assertMatch(keys.publicKey, /^B[A-Za-z0-9_-]{86}$/);
  assertEquals(base64UrlDecode(keys.privateKey).length, 32);
  assertEquals(keys.subject, "mailto:ops@longlines.io");

  const jwt = /t=([^,]+),/.exec(
    await vapidAuthorization("https://fcm.googleapis.com/x", keys, new Date()),
  )![1]!;
  const [h, p, s] = jwt.split(".");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    base64UrlDecode(keys.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlDecode(s!),
      new TextEncoder().encode(`${h}.${p}`),
    ),
  );
});

Deno.test("vapidAuthorization rejects a malformed private key", async () => {
  const { keys } = await testVapid();
  await assertRejects(() =>
    vapidAuthorization("https://fcm.googleapis.com/x", { ...keys, privateKey: "short" }, new Date())
  );
  assertMatch(keys.publicKey, /^B[A-Za-z0-9_-]{86}$/);
});
