import { assertEquals, assertMatch } from "@std/assert";
import {
  MAX_RETRY_AFTER_SECONDS,
  retryAfterSeconds,
  sendDiscord,
  sendPush,
  sendToDestination,
  sendWebhook,
} from "../delivery/send.ts";
import { base64UrlDecode, base64UrlEncode, type VapidKeys } from "../delivery/webpush.ts";
import { signWebhookBody } from "../delivery/hmac.ts";
import { PinnedConnectError, type pinnedPost } from "../delivery/pinned_http.ts";
import type {
  DeliveryDestination,
  PendingDelivery,
  PushDevice,
  PushNotification,
  PushSettings,
} from "../delivery/types.ts";

async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    handler,
  );
  try {
    await fn(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    ac.abort();
    await server.finished;
  }
}

function dest(url: string, type: "discord" | "webhook"): DeliveryDestination {
  return {
    id: "d1",
    type,
    name: "Test",
    url,
    signing_secret: "whsec_testsecret",
    health: "ok",
    consecutive_failures: 0,
  };
}

function delivery(id: number, destination: DeliveryDestination): PendingDelivery {
  return {
    msg_id: id,
    delivery_id: id,
    subscription_id: "s1",
    attempts: 0,
    created_at: new Date().toISOString(),
    destination,
    spot: {
      id,
      source: "pota",
      spot_time: "2026-10-05T14:32:08.000Z",
      callsign: "KK4PWJ",
      base_callsign: "KK4PWJ",
      spotter: "W4ABC",
      frequency_khz: 14062,
      band: "20m",
      mode: "cw",
      mode_family: "cw",
      comment: "",
      pota_reference: "US-2763",
      pota_park_name: null,
      pota_location: "US-NC",
      sota_summit_ref: null,
      wwff_reference: null,
      wwff_reference_name: null,
    },
  };
}

Deno.test("sendDiscord posts one message per 10 spots and reports success", async () => {
  const bodies: unknown[] = [];
  await withServer(
    async (req) => {
      bodies.push(await req.json());
      return new Response(null, { status: 204 });
    },
    async (base) => {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(
        d,
        Array.from({ length: 12 }, (_, i) => delivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result, { ok: true, sent: 12 });
      assertEquals(bodies.length, 2);
      assertEquals((bodies[0] as { embeds: unknown[] }).embeds.length, 10);
    },
  );
});

Deno.test("sendDiscord stops on 429 and reports retry_after without sending the rest", async () => {
  let calls = 0;
  await withServer(
    () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 204 })
        : Response.json({ retry_after: 2.5 }, { status: 429 });
    },
    async (base) => {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(
        d,
        Array.from({ length: 25 }, (_, i) => delivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result.ok, false);
      assertEquals(result.sent, 10);
      assertEquals(result.retryAfterSeconds, 3);
      assertMatch(result.error ?? "", /429/);
      assertEquals(calls, 2);
    },
  );
});

Deno.test("retryAfterSeconds rounds up, caps at a day and refuses what is not a positive number", () => {
  assertEquals(MAX_RETRY_AFTER_SECONDS, 86_400);
  assertEquals(retryAfterSeconds("42"), 42);
  assertEquals(retryAfterSeconds(" 7 "), 7);
  assertEquals(retryAfterSeconds("2.5"), 3);
  assertEquals(retryAfterSeconds(0.2), 1);
  assertEquals(retryAfterSeconds(86_400), 86_400);
  // Past throttle_destination's int: capped, so the throttle still lands.
  assertEquals(retryAfterSeconds("3000000000"), MAX_RETRY_AFTER_SECONDS);
  assertEquals(retryAfterSeconds(1e300), MAX_RETRY_AFTER_SECONDS);
  for (
    const value of [
      "0",
      0,
      "-5",
      -1,
      "soon",
      "",
      "   ",
      "Infinity",
      Infinity,
      NaN,
      null,
      undefined,
      true,
      "Wed, 21 Oct 2026 07:28:00 GMT",
    ]
  ) {
    assertEquals(retryAfterSeconds(value), null, String(value));
  }
});

Deno.test("sendDiscord caps a huge retry_after and falls back to the header, then 5 s", async () => {
  const cases: Array<[Response, number]> = [
    [Response.json({ retry_after: 3e9 }, { status: 429 }), MAX_RETRY_AFTER_SECONDS],
    [
      Response.json({ retry_after: -1 }, { status: 429, headers: { "Retry-After": "9" } }),
      9,
    ],
    [new Response(null, { status: 429, headers: { "Retry-After": "3000000000" } }), 86_400],
    [new Response("not json", { status: 429 }), 5],
  ];
  for (const [response, expected] of cases) {
    await withServer(
      () => response,
      async (base) => {
        const d = dest(`${base}/api/webhooks/1/abc`, "discord");
        const result = await sendDiscord(d, [delivery(1, d)], { allowInsecure: true });
        assertEquals(result.retryAfterSeconds, expected);
      },
    );
  }
});

Deno.test("sendDiscord caps a single run at 30 messages per webhook", async () => {
  let calls = 0;
  await withServer(
    () => {
      calls++;
      return new Response(null, { status: 204 });
    },
    async (base) => {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(
        d,
        Array.from({ length: 320 }, (_, i) => delivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(calls, 30);
      assertEquals(result.ok, false);
      assertEquals(result.sent, 300);
      assertEquals(result.retryAfterSeconds, 60);
    },
  );
});

Deno.test("sendWebhook signs the body and sets the Long Lines headers", async () => {
  let seen: { headers: Headers; body: string } | null = null;
  await withServer(
    async (req) => {
      seen = { headers: req.headers, body: await req.text() };
      return new Response("ok", { status: 200 });
    },
    async (base) => {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d), delivery(2, d)], {
        allowInsecure: true,
      });
      assertEquals(result, { ok: true, sent: 2 });
      const s = seen as unknown as { headers: Headers; body: string };
      assertEquals(s.headers.get("content-type"), "application/json");
      assertMatch(s.headers.get("user-agent") ?? "", /^LongLines\/0\.2/);
      const ts = Number(s.headers.get("x-longlines-timestamp"));
      assertEquals(Number.isInteger(ts), true);
      assertEquals(
        s.headers.get("x-longlines-signature"),
        await signWebhookBody("whsec_testsecret", ts, s.body),
      );
      assertEquals(JSON.parse(s.body).deliveries.length, 2);
    },
  );
});

Deno.test("sendWebhook treats non-2xx as failure with the status in the error", async () => {
  await withServer(
    () => new Response("boom", { status: 500 }),
    async (base) => {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.ok, false);
      assertEquals(result.sent, 0);
      assertMatch(result.error ?? "", /500/);
    },
  );
});

Deno.test("sendWebhook treats a 429 as a rate limit with the Retry-After, not a failure", async () => {
  let calls = 0;
  await withServer(
    () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 429, headers: { "Retry-After": "42" } });
    },
    async (base) => {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(
        d,
        Array.from({ length: 60 }, (_, i) => delivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result.ok, false);
      assertEquals(result.sent, 50);
      assertEquals(result.retryAfterSeconds, 42);
      assertMatch(result.error ?? "", /429/);
      assertEquals(calls, 2);
    },
  );
});

Deno.test("sendWebhook reports a 429 without Retry-After as null so SQL picks the delay", async () => {
  const cases: Record<string, string>[] = [
    {},
    { "Retry-After": "soon" },
    { "Retry-After": "0" },
    { "Retry-After": "-30" },
    { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
  ];
  for (const headers of cases) {
    await withServer(
      () => new Response(null, { status: 429, headers }),
      async (base) => {
        const d = dest(`${base}/spots`, "webhook");
        const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
        assertEquals(result.ok, false);
        assertEquals(result.sent, 0);
        assertEquals(result.retryAfterSeconds, null);
        assertEquals("retryAfterSeconds" in result, true);
      },
    );
  }
});

Deno.test("sendWebhook does not follow redirects and reports them as failures", async () => {
  let followed = false;
  await withServer(
    (req) => {
      if (new URL(req.url).pathname === "/elsewhere") {
        followed = true;
        return new Response("ok");
      }
      return new Response(null, { status: 302, headers: { Location: "/elsewhere" } });
    },
    async (base) => {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.ok, false);
      assertEquals(followed, false);
      assertMatch(result.error ?? "", /redirect/i);
    },
  );
});

Deno.test("sendDiscord does not follow redirects", async () => {
  let followed = false;
  await withServer(
    (req) => {
      if (new URL(req.url).pathname === "/elsewhere") {
        followed = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 301, headers: { Location: "/elsewhere" } });
    },
    async (base) => {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.ok, false);
      assertEquals(followed, false);
      assertMatch(result.error ?? "", /redirect/i);
    },
  );
});

Deno.test("sendWebhook refuses an unsafe destination before connecting", async () => {
  let called = false;
  await withServer(
    () => {
      called = true;
      return new Response("ok");
    },
    async (base) => {
      // Not allowInsecure: a plain-http loopback URL must be refused by the safety check.
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)]);
      assertEquals(result.ok, false);
      assertEquals(called, false);
    },
  );
});

// The pin: a webhook connects to an address urlsafety checked, never to a
// second resolution of the name (DNS rebinding).

interface Post {
  url: string;
  address: string;
  headers: Record<string, string>;
}

/** A pinnedPost stand-in that records where each request would connect. */
function recordingPost(
  posts: Post[],
  answer: (address: string) => number | Error = () => 200,
): typeof pinnedPost {
  return (url, address, init) => {
    posts.push({ url: url.href, address, headers: { ...init.headers } });
    const result = answer(address);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({ status: result, headers: new Headers() });
  };
}

Deno.test("sendWebhook connects to the address it checked and resolves the name once", async () => {
  let lookups = 0;
  const resolver = (host: string) => {
    lookups++;
    assertEquals(host, "hooks.example.com");
    return Promise.resolve(["93.184.216.34", "2606:2800:220:1::1"]);
  };
  const posts: Post[] = [];
  const d = dest("https://hooks.example.com/spots?k=1", "webhook");
  const result = await sendWebhook(d, Array.from({ length: 60 }, (_, i) => delivery(i + 1, d)), {
    resolver,
    webhookPost: recordingPost(posts),
  });
  assertEquals(result, { ok: true, sent: 60 });
  assertEquals(lookups, 1);
  assertEquals(posts.map((p) => [p.url, p.address]), [
    ["https://hooks.example.com/spots?k=1", "93.184.216.34"],
    ["https://hooks.example.com/spots?k=1", "93.184.216.34"],
  ]);
  assertEquals(Object.keys(posts[0]!.headers).sort(), [
    "Accept",
    "Content-Type",
    "User-Agent",
    "X-LongLines-Signature",
    "X-LongLines-Timestamp",
  ]);
});

Deno.test("sendWebhook refuses a name that resolves to a private address before connecting", async () => {
  const posts: Post[] = [];
  const d = dest("https://rebind.example.com/spots", "webhook");
  const result = await sendWebhook(d, [delivery(1, d)], {
    resolver: () => Promise.resolve(["93.184.216.34", "127.0.0.1"]),
    webhookPost: recordingPost(posts),
  });
  assertEquals(result, {
    ok: false,
    sent: 0,
    error: "rebind.example.com resolves to a private address",
  });
  assertEquals(posts, []);
});

Deno.test("sendWebhook uses an IP literal as its own address without resolving", async () => {
  const posts: Post[] = [];
  const d = dest("https://[2606:2800:220:1::1]:8443/spots", "webhook");
  const result = await sendWebhook(d, [delivery(1, d)], {
    resolver: () => Promise.reject(new Error("must not resolve")),
    webhookPost: recordingPost(posts),
  });
  assertEquals(result, { ok: true, sent: 1 });
  assertEquals(posts.map((p) => p.address), ["2606:2800:220:1::1"]);
});

Deno.test("sendWebhook tries the next checked address only when connecting fails", async () => {
  const resolver = () => Promise.resolve(["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]);
  const d = dest("https://hooks.example.com/spots", "webhook");
  const batch = Array.from({ length: 60 }, (_, i) => delivery(i + 1, d));

  // Refused on the first: the second takes both payloads.
  const posts: Post[] = [];
  const refusedFirst = (a: string) =>
    a === "192.0.2.1" ? new PinnedConnectError("Connection refused") : 200;
  assertEquals(
    await sendWebhook(d, batch, { resolver, webhookPost: recordingPost(posts, refusedFirst) }),
    { ok: true, sent: 60 },
  );
  assertEquals(posts.map((p) => p.address), ["192.0.2.1", "192.0.2.2", "192.0.2.2"]);

  // Refused everywhere: at most three addresses, then the last error.
  const all: Post[] = [];
  const refused = () => new PinnedConnectError("Connection refused");
  assertEquals(
    await sendWebhook(d, batch, { resolver, webhookPost: recordingPost(all, refused) }),
    { ok: false, sent: 0, error: "Webhook request failed: Connection refused" },
  );
  assertEquals(all.map((p) => p.address), ["192.0.2.1", "192.0.2.2", "192.0.2.3"]);

  // Anything after connecting may have reached the receiver: no second try.
  const once: Post[] = [];
  const timedOut = () => new Error("timed out after 10000 ms");
  assertEquals(
    await sendWebhook(d, batch, { resolver, webhookPost: recordingPost(once, timedOut) }),
    { ok: false, sent: 0, error: "Webhook request failed: timed out after 10000 ms" },
  );
  assertEquals(once.map((p) => p.address), ["192.0.2.1"]);
});

Deno.test("sendWebhook with allowInsecure connects to a name itself, trying both loopbacks", async () => {
  const posts: Post[] = [];
  const v4Refused = (a: string) =>
    a === "127.0.0.1" ? new PinnedConnectError("Connection refused") : 204;
  const local = dest("http://localhost:9999/spots", "webhook");
  assertEquals(
    await sendWebhook(local, [delivery(1, local)], {
      allowInsecure: true,
      webhookPost: recordingPost(posts, v4Refused),
    }),
    { ok: true, sent: 1 },
  );
  const named = dest("http://receiver.test:9999/spots", "webhook");
  await sendWebhook(named, [delivery(1, named)], {
    allowInsecure: true,
    resolver: () => Promise.reject(new Error("must not resolve")),
    webhookPost: recordingPost(posts),
  });
  assertEquals(posts.map((p) => p.address), ["127.0.0.1", "::1", "receiver.test"]);
});

Deno.test("sendWebhook with allowInsecure reports a URL it cannot parse", async () => {
  const d = dest("not a url", "webhook");
  assertEquals(await sendWebhook(d, [delivery(1, d)], { allowInsecure: true }), {
    ok: false,
    sent: 0,
    error: "Use an https URL.",
  });
});

Deno.test("sendWebhook reports a refused connection to a local receiver", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const d = dest(`http://127.0.0.1:${port}/spots`, "webhook");
  const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
  assertEquals(result.ok, false);
  assertMatch(result.error ?? "", /^Webhook request failed: /);
});

// --- push ---------------------------------------------------------------

// The RFC 8291 user agent keys, so the test can decrypt what a device receives.
const UA = {
  public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

let vapidKeys: VapidKeys | undefined;
async function vapid(): Promise<VapidKeys> {
  if (vapidKeys) return vapidKeys;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  vapidKeys = {
    publicKey: base64UrlEncode(raw),
    privateKey: jwk.d ?? "",
    subject: "mailto:ops@longlines.io",
  };
  return vapidKeys;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: string | Uint8Array<ArrayBuffer>,
  bytes: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const infoBytes = typeof info === "string" ? new TextEncoder().encode(info) : info;
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: infoBytes },
      key,
      bytes * 8,
    ),
  );
}

/** What the browser does with an aes128gcm body (RFC 8291 from the receiving side). */
async function decrypt(body: Uint8Array<ArrayBuffer>): Promise<PushNotification> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + body[20]!);
  const uaPublic = base64UrlDecode(UA.public);
  const point = (raw: Uint8Array) => ({
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(raw.slice(1, 33)),
    y: base64UrlEncode(raw.slice(33, 65)),
  });
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const uaPrivate = await crypto.subtle.importKey(
    "jwk",
    { ...point(uaPublic), d: UA.private },
    ecdh,
    false,
    ["deriveBits"],
  );
  const asKey = await crypto.subtle.importKey("jwk", point(asPublic), ecdh, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256),
  );
  const info = new Uint8Array([
    ...new TextEncoder().encode("WebPush: info\0"),
    ...uaPublic,
    ...asPublic,
  ]);
  const ikm = await hkdf(base64UrlDecode(UA.auth), secret, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + body[20]!)),
  );
  assertEquals(padded[padded.length - 1], 0x02);
  return JSON.parse(new TextDecoder().decode(padded.slice(0, -1)));
}

interface PushRequest {
  path: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
}

function device(base: string, path: string): PushDevice {
  return { endpoint: `${base}${path}`, p256dh: UA.public, auth: UA.auth };
}

function pushDest(devices: PushDevice[] | undefined): DeliveryDestination {
  return {
    id: "p1",
    type: "push",
    name: "Push notifications",
    url: null,
    signing_secret: null,
    health: "ok",
    consecutive_failures: 0,
    devices,
  };
}

/**
 * Serves push endpoints whose status is the first path segment ("/201/a", "/410/b", ...),
 * or one status per request in turn ("/201,500/a").
 */
async function withPushServer(
  fn: (base: string, requests: PushRequest[]) => Promise<void>,
): Promise<void> {
  const requests: PushRequest[] = [];
  await withServer(async (req) => {
    const path = new URL(req.url).pathname;
    const seen = requests.filter((r) => r.path === path).length;
    requests.push({ path, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    const statuses = (path.split("/")[1] ?? "").split(",");
    const status = Number(statuses[Math.min(seen, statuses.length - 1)]);
    if (status === 301) return new Response(null, { status, headers: { Location: "/201/x" } });
    if (status === 429) return new Response(null, { status, headers: { "Retry-After": "42" } });
    return new Response(null, { status });
  }, (base) => fn(base, requests));
}

// The settings a push destination carries from SQL (push_destination_settings), the defaults.
const PUSH_SETTINGS: PushSettings = {
  title_fields: ["callsign", "frequency", "mode"],
  body_fields: ["source", "reference", "place_name", "state"],
  show_field_names: false,
  body_separator: "dot",
  tap_target: "profile",
  action_buttons: true,
  urgency: "normal",
  ttl_seconds: 1800,
  replace_same_station: true,
  sound: true,
  quiet_enabled: false,
  quiet_from: "22:00:00",
  quiet_until: "07:00:00",
  quiet_mode: "silent",
};

Deno.test("sendPush encrypts one notification per spot to a device, with the legacy headers when the claim carried no settings", async () => {
  await withPushServer(async (base, requests) => {
    const d = pushDest([device(base, "/201/a")]);
    const batch = Array.from({ length: 5 }, (_, i) => delivery(i + 1, d));
    batch[1]!.spot = { ...batch[1]!.spot, callsign: "W4/KK4PWJ/P" };
    const result = await sendPush(d, batch, { allowInsecure: true, vapid: await vapid() });

    assertEquals(result, {
      ok: true,
      sent: 5,
      expiredEndpoints: [],
      deviceResults: { ok: [`${base}/201/a`], errors: {} },
    });
    assertEquals(requests.length, 5);
    const notes = await Promise.all(requests.map((r) => decrypt(r.body)));
    assertEquals(notes.map((n) => n.tag), [
      "spot:KK4PWJ",
      "spot:W4/KK4PWJ/P",
      "spot:KK4PWJ",
      "spot:KK4PWJ",
      "spot:KK4PWJ",
    ]);
    assertEquals(notes[0]?.url, "/call/KK4PWJ");
    assertEquals(notes[0]?.title, "KK4PWJ");

    const h = requests[1]!.headers;
    assertEquals(h.get("ttl"), "900");
    assertEquals(h.get("urgency"), "high");
    assertEquals(h.get("topic"), "spotW4_KK4PWJ_P");
    assertEquals(h.get("content-encoding"), "aes128gcm");
    assertEquals(h.get("content-type"), "application/octet-stream");
    assertMatch(h.get("user-agent") ?? "", /^LongLines\//);
    assertMatch(h.get("authorization") ?? "", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B[\w-]+$/);
  });
});

Deno.test("sendPush sends the destination's urgency and TTL and SQL's text", async () => {
  await withPushServer(async (base, requests) => {
    const d = {
      ...pushDest([device(base, "/201/a")]),
      push: { ...PUSH_SETTINGS, urgency: "low" as const, ttl_seconds: 14400 },
    };
    const row = delivery(1, d);
    row.spot = {
      ...row.spot,
      push_title: "KK4PWJ · 14.062 MHz · CW",
      push_body: "POTA · US-2763 · Eno River State Park · NC",
      push_url: "/call/KK4PWJ",
      push_source_url: "https://pota.app/#/park/US-2763",
    };
    const result = await sendPush(d, [row], { allowInsecure: true, vapid: await vapid() });
    assertEquals(result.ok, true);
    assertEquals(requests.length, 1);
    assertEquals(requests[0]!.headers.get("ttl"), "14400");
    assertEquals(requests[0]!.headers.get("urgency"), "low");
    const note = await decrypt(requests[0]!.body);
    assertEquals(note.title, "KK4PWJ · 14.062 MHz · CW");
    assertEquals(note.body, "POTA · US-2763 · Eno River State Park · NC");
    assertEquals(note.actions?.map((a) => a.title), ["Open profile", "Open on POTA"]);
    assertEquals(note.silent, false);
  });
});

Deno.test("sendPush in quiet hours set to Don't send makes no request and reports the batch sent", async () => {
  await withPushServer(async (base, requests) => {
    const d = {
      ...pushDest([device(base, "/201/a")]),
      push: { ...PUSH_SETTINGS, quiet_mode: "skip" as const },
      quiet_now: true,
    };
    const batch = [delivery(1, d), delivery(2, d)];
    // No VAPID keys and no devices needed: nothing is sent and nothing is reported per device.
    assertEquals(await sendPush({ ...d, devices: [] }, batch, { allowInsecure: true }), {
      ok: true,
      sent: 2,
    });
    assertEquals(await sendPush(d, batch, { allowInsecure: true, vapid: await vapid() }), {
      ok: true,
      sent: 2,
    });
    assertEquals(requests.length, 0);
  });
});

Deno.test("sendPush in quiet hours set to Send silently still sends, silently", async () => {
  await withPushServer(async (base, requests) => {
    const d = { ...pushDest([device(base, "/201/a")]), push: PUSH_SETTINGS, quiet_now: true };
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result.ok, true);
    assertEquals(requests.length, 1);
    const note = await decrypt(requests[0]!.body);
    assertEquals([note.silent, note.renotify], [true, false]);
  });
});

Deno.test("sendPush counts the batch sent when one device accepts and reports gone ones", async () => {
  await withPushServer(async (base, requests) => {
    const d = pushDest([
      device(base, "/410/gone"),
      device(base, "/202/ok"),
      device(base, "/500/bad"),
    ]);
    const result = await sendPush(d, [delivery(1, d), delivery(2, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result, {
      ok: true,
      sent: 2,
      expiredEndpoints: [`${base}/410/gone`],
      deviceResults: { ok: [`${base}/202/ok`], errors: { [`${base}/500/bad`]: "Push HTTP 500" } },
    });
    // A device stops at its first refusal; the accepting one gets both spots.
    assertEquals(requests.filter((r) => r.path === "/202/ok").length, 2);
    assertEquals(requests.filter((r) => r.path === "/410/gone").length, 1);
    assertEquals(requests.filter((r) => r.path === "/500/bad").length, 1);
  });
});

Deno.test("sendPush fails the batch when no device accepts", async () => {
  await withPushServer(async (base) => {
    const d = pushDest([device(base, "/500/a"), device(base, "/404/b")]);
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result, {
      ok: false,
      sent: 0,
      error: "Push HTTP 500",
      expiredEndpoints: [`${base}/404/b`],
      deviceResults: { ok: [], errors: { [`${base}/500/a`]: "Push HTTP 500" } },
    });
  });
});

Deno.test("sendPush with every device gone asks for a device", async () => {
  await withPushServer(async (base) => {
    const d = pushDest([device(base, "/410/a"), device(base, "/404/b")]);
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result.ok, false);
    assertEquals(result.error, "Turn on notifications on a device first.");
    assertEquals(result.expiredEndpoints, [`${base}/410/a`, `${base}/404/b`]);
  });
});

Deno.test("sendWebhook caps a huge Retry-After at a day so the throttle still fits an int", async () => {
  await withServer(
    () => new Response(null, { status: 429, headers: { "Retry-After": "3000000000" } }),
    async (base) => {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
    },
  );
});

Deno.test("sendPush caps a huge Retry-After at a day and waits 60 s without a usable one", async () => {
  const cases: Array<[Record<string, string>, number]> = [
    [{ "Retry-After": "3000000000" }, MAX_RETRY_AFTER_SECONDS],
    [{ "Retry-After": "0" }, 60],
    [{ "Retry-After": "soon" }, 60],
  ];
  for (const [headers, expected] of cases) {
    await withServer(
      () => new Response(null, { status: 429, headers }),
      async (base) => {
        const d = pushDest([device(base, "/a")]);
        const result = await sendPush(d, [delivery(1, d)], {
          allowInsecure: true,
          vapid: await vapid(),
        });
        assertEquals(result.retryAfterSeconds, expected);
      },
    );
  }
});

Deno.test("sendPush treats a 429 as a rate limit, not a failure", async () => {
  await withPushServer(async (base) => {
    const d = pushDest([device(base, "/429/a"), device(base, "/500/b")]);
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result.ok, false);
    assertEquals(result.sent, 0);
    assertEquals(result.retryAfterSeconds, 42);
    assertEquals(result.deviceResults, {
      ok: [],
      errors: {
        [`${base}/429/a`]: "Push HTTP 429 (rate limited)",
        [`${base}/500/b`]: "Push HTTP 500",
      },
    });
  });
});

Deno.test("sendPush records a rate-limited device when another device took the batch", async () => {
  await withPushServer(async (base) => {
    const d = pushDest([device(base, "/201/a"), device(base, "/429/b")]);
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result, {
      ok: true,
      sent: 1,
      expiredEndpoints: [],
      deviceResults: {
        ok: [`${base}/201/a`],
        errors: { [`${base}/429/b`]: "Push HTTP 429 (rate limited)" },
      },
    });
  });
});

Deno.test("sendPush does not retry a batch a device already started showing", async () => {
  // Retrying would show the accepted notifications again on every attempt.
  for (const path of ["/201,500/a", "/201,429/a"]) {
    await withPushServer(async (base, requests) => {
      const d = pushDest([device(base, path)]);
      const result = await sendPush(d, [delivery(1, d), delivery(2, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.ok, true, path);
      assertEquals(result.sent, 2);
      assertEquals(result.retryAfterSeconds, undefined);
      assertEquals(result.deviceResults?.ok, []);
      assertMatch(result.deviceResults?.errors[`${base}${path}`] ?? "", /^Push HTTP (500|429)/);
      assertEquals(requests.length, 2);
    });
  }
});

Deno.test("sendPush reports a bad VAPID key as server configuration, not a device fault", async () => {
  await withPushServer(async (base, requests) => {
    const d = pushDest([device(base, "/201/a"), device(base, "/201/b")]);
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: { ...(await vapid()), privateKey: "short" },
    });
    assertEquals(result, { ok: false, sent: 0, error: "Push isn't configured on the server." });
    assertEquals(requests, []);
  });
});

Deno.test("sendPush signs one VAPID JWT per origin with the pinned clock", async () => {
  await withPushServer(async (base, requests) => {
    const now = new Date("2026-10-13T12:00:00Z");
    const d = pushDest([device(base, "/201/a"), device(base, "/201/b")]);
    await sendPush(d, [delivery(1, d)], { allowInsecure: true, vapid: await vapid(), now });
    const headers = requests.map((r) => r.headers.get("authorization"));
    assertEquals(headers[0], headers[1]);
    const claims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(/t=[\w-]+\.([\w-]+)\./.exec(headers[0]!)![1]!)),
    );
    assertEquals(claims.exp, now.getTime() / 1000 + 12 * 60 * 60);
  });
});

Deno.test("sendPush does not follow redirects", async () => {
  await withPushServer(async (base, requests) => {
    const d = pushDest([device(base, "/301/a")]);
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result.ok, false);
    assertMatch(result.error ?? "", /redirect/i);
    assertEquals(requests.map((r) => r.path), ["/301/a"]);
  });
});

Deno.test("sendPush reports a network error per device", async () => {
  const d = pushDest([{ endpoint: "http://127.0.0.1:9/x", p256dh: UA.public, auth: UA.auth }]);
  const result = await sendPush(d, [delivery(1, d)], { allowInsecure: true, vapid: await vapid() });
  assertEquals(result.ok, false);
  assertMatch(result.error ?? "", /^Push request failed: /);
});

Deno.test("sendPush checks the endpoint allowlist before connecting", async () => {
  await withPushServer(async (base, requests) => {
    const d = pushDest([device(base, "/201/a")]);
    const result = await sendPush(d, [delivery(1, d)], { vapid: await vapid() });
    assertEquals(result.ok, false);
    assertEquals(result.error, "Use a browser push service.");
    assertEquals(requests, []);
  });
});

Deno.test("sendPush needs a device and the VAPID keys", async () => {
  const none = pushDest([]);
  assertEquals(await sendPush(none, [delivery(1, none)], { vapid: await vapid() }), {
    ok: false,
    sent: 0,
    error: "Turn on notifications on a device first.",
  });
  const missing = pushDest(undefined);
  assertEquals(
    (await sendPush(missing, [delivery(1, missing)], { vapid: await vapid() })).error,
    "Turn on notifications on a device first.",
  );
  const unconfigured = pushDest([
    { endpoint: "https://fcm.googleapis.com/x", p256dh: UA.public, auth: UA.auth },
  ]);
  assertEquals(await sendPush(unconfigured, [delivery(1, unconfigured)]), {
    ok: false,
    sent: 0,
    error: "Push isn't configured on the server.",
  });
});

Deno.test("sendToDestination picks the sender by type", async () => {
  await withPushServer(async (base, requests) => {
    const p = pushDest([device(base, "/201/a")]);
    const options = { allowInsecure: true, vapid: await vapid() };
    assertEquals((await sendToDestination(p, [delivery(1, p)], options)).ok, true);
    const w = dest(`${base}/200/hook`, "webhook");
    assertEquals(await sendToDestination(w, [delivery(1, w)], options), { ok: true, sent: 1 });
    const c = dest(`${base}/204/api/webhooks/1/abc`, "discord");
    assertEquals(await sendToDestination(c, [delivery(1, c)], options), { ok: true, sent: 1 });
    assertEquals(requests.map((r) => r.path), ["/201/a", "/200/hook", "/204/api/webhooks/1/abc"]);
  });
});

Deno.test("Discord and webhook sends refuse a destination without a URL", async () => {
  const w = { ...dest("x", "webhook"), url: null };
  assertEquals((await sendWebhook(w, [delivery(1, w)], { allowInsecure: true })).ok, false);
  const c = { ...dest("x", "discord"), url: null };
  assertEquals((await sendDiscord(c, [delivery(1, c)], { allowInsecure: true })).ok, false);
});
