import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  base64UrlDecode,
  base64UrlEncode,
  encryptPushPayload,
  generateVapidKeys,
  MAX_PUSH_PLAINTEXT_BYTES,
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
  let privateKey = "";
  if (jwk.d !== undefined) {
    privateKey = jwk.d;
  }
  return {
    pair,
    keys: {
      publicKey: base64UrlEncode(raw),
      privateKey,
      subject: "mailto:ops@longlines.io",
    },
    jwk,
  };
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

Deno.test(
  "base64url round-trips bytes without padding and accepts padded input",
  function (): void {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x01]);
    assertEquals(base64UrlEncode(bytes), "-__-AAE");
    assertEquals(base64UrlDecode("-__-AAE"), bytes);
    assertEquals(base64UrlDecode("-__-AAE="), bytes);
    assertEquals(base64UrlDecode(""), new Uint8Array());
  },
);

Deno.test(
  "encryptPushPayload reproduces the RFC 8291 Appendix A vector byte for byte",
  async function (): Promise<void> {
    const body = await encryptPushPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.authSecret },
      {
        serverKey: { publicKey: RFC.asPublic, privateKey: RFC.asPrivate },
        salt: base64UrlDecode(RFC.salt),
      },
    );
    assertEquals(base64UrlEncode(body), RFC.body);
  },
);

Deno.test(
  "encryptPushPayload uses a fresh key and salt by default",
  async function (): Promise<void> {
    const plaintext = new TextEncoder().encode(RFC.plaintext);
    const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
    const a = await encryptPushPayload(plaintext, keys, {});
    const b = await encryptPushPayload(plaintext, keys, {});
    // salt(16) + rs(4) + idlen(1) + key(65) + plaintext + delimiter + tag(16)
    assertEquals(a.length, 86 + plaintext.length + 1 + 16);
    assertEquals(new DataView(a.buffer).getUint32(16), 4096);
    assertEquals(a[20], 65);
    assert(base64UrlEncode(a.slice(0, 16)) !== base64UrlEncode(b.slice(0, 16)), "salt repeats");
    assert(base64UrlEncode(a.slice(21, 86)) !== base64UrlEncode(b.slice(21, 86)), "key repeats");
  },
);

Deno.test(
  "encryptPushPayload keeps the whole body, header included, within 4096 bytes",
  async function (): Promise<void> {
    assertEquals(MAX_PUSH_PLAINTEXT_BYTES, 3993);
    const keys = { p256dh: RFC.uaPublic, auth: RFC.authSecret };
    const body = await encryptPushPayload(new Uint8Array(MAX_PUSH_PLAINTEXT_BYTES), keys, {});
    assertEquals(body.length, 4096);
    await assertRejects(
      () => encryptPushPayload(new Uint8Array(MAX_PUSH_PLAINTEXT_BYTES + 1), keys, {}),
      Error,
      "too large",
    );
  },
);

Deno.test(
  "encryptPushPayload rejects subscription keys of the wrong size",
  async function (): Promise<void> {
    const plaintext = new TextEncoder().encode("x");
    await assertRejects(
      () => encryptPushPayload(plaintext, { p256dh: RFC.uaPublic, auth: "AAAA" }, {}),
      Error,
      "auth",
    );
    await assertRejects(
      () => encryptPushPayload(plaintext, { p256dh: "AAAA", auth: RFC.authSecret }, {}),
      Error,
      "p256dh",
    );
  },
);

Deno.test(
  "vapidAuthorization signs an ES256 JWT for the endpoint's origin",
  async function (): Promise<void> {
    const vapid = await testVapid();
    const keys = vapid.keys;
    const now = new Date("2026-10-13T12:00:00Z");
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, now);

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    assert(match, header);
    const jwt = match[1];
    const k = match[2];
    assertEquals(k, keys.publicKey);

    const parts = jwt!.split(".");
    const h = parts[0];
    const p = parts[1];
    const s = parts[2];
    assertEquals(decodeJson(h!), { typ: "JWT", alg: "ES256" });
    const claims = decodeJson(p!);
    assertEquals(claims.aud, "https://fcm.googleapis.com");
    assertEquals(claims.sub, "mailto:ops@longlines.io");
    assertEquals(claims.exp, now.getTime() / 1000 + 12 * 60 * 60);

    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      vapid.pair.publicKey,
      base64UrlDecode(s!),
      new TextEncoder().encode(`${h}.${p}`),
    );
    assert(verified, "signature does not verify with the public key");
  },
);

Deno.test("vapidAuthorization accepts the private key as a JWK", async function (): Promise<void> {
  const vapid = await testVapid();
  const header = await vapidAuthorization(
    "https://web.push.apple.com/QGuQ",
    {
      publicKey: vapid.keys.publicKey,
      privateKey: JSON.stringify(vapid.jwk),
      subject: vapid.keys.subject,
    },
    new Date(),
  );
  const jwt = /t=([^,]+),/.exec(header)![1]!;
  const parts = jwt.split(".");
  const h = parts[0];
  const p = parts[1];
  const s = parts[2];
  assertEquals(decodeJson(p!).aud, "https://web.push.apple.com");
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      vapid.pair.publicKey,
      base64UrlDecode(s!),
      new TextEncoder().encode(`${h}.${p}`),
    ),
  );
});

Deno.test("vapidKeysFromEnv needs all three values", function (): void {
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
    const partial: Record<string, string> = {};
    for (const entry of Object.entries(env)) {
      partial[entry[0]] = entry[1];
    }
    partial[missing] = " ";
    assertEquals(vapidKeysFromEnv((k) => partial[k]), undefined, missing);
  }
});

Deno.test(
  "generateVapidKeys makes a pair that signs a verifiable JWT",
  async function (): Promise<void> {
    const keys = await generateVapidKeys("mailto:ops@longlines.io");
    assertMatch(keys.publicKey, /^B[A-Za-z0-9_-]{86}$/);
    assertEquals(base64UrlDecode(keys.privateKey).length, 32);
    assertEquals(keys.subject, "mailto:ops@longlines.io");

    const jwt = /t=([^,]+),/.exec(
      await vapidAuthorization("https://fcm.googleapis.com/x", keys, new Date()),
    )![1]!;
    const parts = jwt.split(".");
    const h = parts[0];
    const p = parts[1];
    const s = parts[2];
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
  },
);

Deno.test("vapidAuthorization rejects a malformed private key", async function (): Promise<void> {
  const keys = (await testVapid()).keys;
  await assertRejects(() =>
    vapidAuthorization(
      "https://fcm.googleapis.com/x",
      { publicKey: keys.publicKey, privateKey: "short", subject: keys.subject },
      new Date(),
    )
  );
  assertMatch(keys.publicKey, /^B[A-Za-z0-9_-]{86}$/);
});
