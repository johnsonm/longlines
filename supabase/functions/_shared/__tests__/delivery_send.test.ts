import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  MAX_RETRY_AFTER_SECONDS,
  retryAfterSeconds,
  sendDiscord,
  sendPush,
  type SendResult,
  sendToDestination,
  sendWebhook,
} from "../delivery/send.ts";
import { base64UrlDecode, base64UrlEncode, type VapidKeys } from "../delivery/webpush.ts";
import { signWebhookBody } from "../delivery/hmac.ts";
import {
  PinnedConnectError,
  PinnedHttpError,
  type pinnedPost,
  type PinnedPostInit,
  type PinnedResponse,
} from "../delivery/pinned_http.ts";
import type {
  DeliveryDestination,
  DiscordSettings,
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

/** The result's error, or "" when it has none, for assertMatch. */
function errorText(result: SendResult): string {
  if (result.error === undefined) {
    return "";
  }
  return result.error;
}

/** A header's value, or "" when it is absent, for assertMatch. */
function headerText(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null) {
    return "";
  }
  return value;
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
      wwbota_references: null,
      wwbota_reference_name: null,
      iota_reference: null,
    },
  };
}

Deno.test(
  "sendDiscord posts one message per 10 spots and reports success",
  async function (): Promise<void> {
    const bodies: unknown[] = [];
    async function receive(req: Request): Promise<Response> {
      bodies.push(await req.json());
      return new Response(null, { status: 204 });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(
        d,
        Array.from({ length: 12 }, (_, i) => delivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result, { ok: true, sent: 12 });
      assertEquals(bodies.length, 2);
      assertEquals((bodies[0] as { embeds: unknown[] }).embeds.length, 10);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendDiscord stops on 429 and reports retry_after without sending the rest",
  async function (): Promise<void> {
    let calls = 0;
    function receive(): Response {
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ retry_after: 2.5 }, { status: 429 });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(
        d,
        Array.from({ length: 25 }, (_, i) => delivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result.ok, false);
      assertEquals(result.sent, 10);
      assertEquals(result.retryAfterSeconds, 3);
      assertMatch(errorText(result), /429/);
      assertEquals(calls, 2);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "retryAfterSeconds rounds up, caps at a day and refuses what is not a positive number",
  function (): void {
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
  },
);

Deno.test(
  "sendDiscord caps a huge retry_after and falls back to the header, then null",
  async function (): Promise<void> {
    // Null without either, so throttle_destination picks the level's backoff.
    const cases: Array<[Response, number | null]> = [
      [Response.json({ retry_after: 3e9 }, { status: 429 }), MAX_RETRY_AFTER_SECONDS],
      [
        Response.json({ retry_after: -1 }, { status: 429, headers: { "Retry-After": "9" } }),
        9,
      ],
      [new Response(null, { status: 429, headers: { "Retry-After": "3000000000" } }), 86_400],
      [new Response("not json", { status: 429 }), null],
      // A body of another shape counts as no body: the header decides.
      [
        Response.json({ retry_after: true }, { status: 429, headers: { "Retry-After": "5" } }),
        5,
      ],
      [Response.json([7], { status: 429, headers: { "Retry-After": "4" } }), 4],
    ];
    async function send(base: string, expected: number | null): Promise<void> {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.retryAfterSeconds, expected);
      assertEquals("retryAfterSeconds" in result, true);
    }
    for (const c of cases) {
      const response = c[0];
      const expected = c[1];
      await withServer(
        () => response,
        (base) => send(base, expected),
      );
    }
  },
);

Deno.test(
  "sendDiscord caps a single run at 30 messages per webhook",
  async function (): Promise<void> {
    let calls = 0;
    function receive(): Response {
      calls++;
      return new Response(null, { status: 204 });
    }
    async function send(base: string): Promise<void> {
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
    }
    await withServer(receive, send);
  },
);

const DISCORD_SETTINGS: DiscordSettings = {
  style: "card",
  title_fields: ["callsign", "frequency", "mode"],
  detail_fields: ["source", "reference", "place_name", "state"],
  grid_fields: ["band", "spotter"],
  title_link: "profile",
  card_color: "source",
  footer: true,
  line_fields: ["callsign", "frequency", "mode", "source", "reference", "place_name"],
  bold_first: true,
  link_preview: "hidden",
  show_field_names: false,
  separator: "dot",
  batch_seconds: 0,
};

/** A Discord delivery as claim_deliveries hands it over after the migration: rendered in SQL. */
function renderedDelivery(id: number, destination: DeliveryDestination): PendingDelivery {
  const d = delivery(id, destination);
  let style: DiscordSettings["style"] = "card";
  if (destination.discord !== undefined) {
    style = destination.discord.style;
  }
  d.spot.discord_style = style;
  d.spot.discord_title = `KK4PWJ #${id}`;
  d.spot.discord_description = "POTA · US-2763";
  d.spot.discord_grid = [{ name: "Band", value: "20m" }];
  d.spot.discord_footer = "POTA · 14:32 UTC";
  d.spot.discord_color = 3066993;
  d.spot.discord_url = "https://longlines.io/call/KK4PWJ";
  d.spot.discord_line = `**[KK4PWJ](https://longlines.io/call/KK4PWJ)** #${id}`;
  d.spot.discord_suppress_embeds = style === "plain";
  return d;
}

Deno.test(
  "sendDiscord with settings and no window sends one message per spot",
  async function (): Promise<void> {
    const bodies: Array<{ embeds: Array<{ title: string; color: number }> }> = [];
    async function receive(req: Request): Promise<Response> {
      bodies.push(await req.json());
      return new Response(null, { status: 204 });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      d.discord = DISCORD_SETTINGS;
      const result = await sendDiscord(
        d,
        Array.from({ length: 5 }, (_, i) => renderedDelivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result, { ok: true, sent: 5 });
      assertEquals(bodies.length, 5);
      assertEquals(bodies.map((b) => b.embeds.length), Array(5).fill(1));
      assertEquals(bodies[0]!.embeds[0]!.title, "KK4PWJ #1");
      assertEquals(bodies[0]!.embeds[0]!.color, 3066993);
      assertEquals((bodies[0] as unknown as { allowed_mentions: unknown }).allowed_mentions, {
        parse: [],
      });
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendDiscord groups a busy claim into at most five messages",
  async function (): Promise<void> {
    let calls = 0;
    function receive(): Response {
      calls++;
      return new Response(null, { status: 204 });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      d.discord = DISCORD_SETTINGS;
      const result = await sendDiscord(
        d,
        Array.from({ length: 40 }, (_, i) => renderedDelivery(i + 1, d)),
        { allowInsecure: true },
      );
      // ceil(40 / 5) = 8 spots a message: 5 messages, within Discord's 5 per 2 seconds.
      assertEquals(result, { ok: true, sent: 40 });
      assertEquals(calls, 5);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendDiscord posts plain lines as content with flags and counts sent by line",
  async function (): Promise<void> {
    const bodies: unknown[] = [];
    let calls = 0;
    async function receive(req: Request): Promise<Response> {
      calls++;
      bodies.push(await req.json());
      if (calls === 1) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ retry_after: 1 }, { status: 429 });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const settings = structuredClone(DISCORD_SETTINGS);
      settings.style = "plain";
      settings.batch_seconds = 30;
      d.discord = settings;
      const result = await sendDiscord(
        d,
        Array.from({ length: 13 }, (_, i) => renderedDelivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result.ok, false);
      assertEquals(result.sent, 10);
      assertEquals(result.retryAfterSeconds, 1);
      const first = bodies[0] as { content: string; flags: number; allowed_mentions: unknown };
      assertEquals(first.content.split("\n").length, 10);
      assertEquals(
        first.content.split("\n")[0],
        "**[KK4PWJ](https://longlines.io/call/KK4PWJ)** #1",
      );
      assertEquals(first.flags, 4);
      assertEquals(first.allowed_mentions, { parse: [] });
      assertEquals("embeds" in first, false);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendWebhook signs the body and sets the Long Lines headers",
  async function (): Promise<void> {
    let seen: { headers: Headers; body: string } | null = null;
    async function receive(req: Request): Promise<Response> {
      seen = { headers: req.headers, body: await req.text() };
      return new Response("ok", { status: 200 });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d), delivery(2, d)], {
        allowInsecure: true,
      });
      assertEquals(result, { ok: true, sent: 2, attempted: 2, status: 200 });
      const s = seen as unknown as { headers: Headers; body: string };
      assertEquals(s.headers.get("content-type"), "application/json");
      assertMatch(headerText(s.headers, "user-agent"), /^LongLines\/0\.2/);
      const ts = Number(s.headers.get("x-longlines-timestamp"));
      assertEquals(Number.isInteger(ts), true);
      assertEquals(
        s.headers.get("x-longlines-signature"),
        await signWebhookBody("whsec_testsecret", ts, s.body),
      );
      assertEquals(JSON.parse(s.body).deliveries.length, 2);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendWebhook treats non-2xx as failure with the status in the error",
  async function (): Promise<void> {
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.ok, false);
      assertEquals(result.sent, 0);
      assertMatch(errorText(result), /500/);
    }
    await withServer(() => new Response("boom", { status: 500 }), send);
  },
);

Deno.test(
  "sendWebhook treats a 429 as a rate limit with the Retry-After, not a failure",
  async function (): Promise<void> {
    let calls = 0;
    function receive(): Response {
      calls++;
      if (calls === 1) {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 429, headers: { "Retry-After": "42" } });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(
        d,
        Array.from({ length: 60 }, (_, i) => delivery(i + 1, d)),
        { allowInsecure: true },
      );
      assertEquals(result.ok, false);
      assertEquals(result.sent, 50);
      assertEquals(result.retryAfterSeconds, 42);
      assertMatch(errorText(result), /429/);
      assertEquals(calls, 2);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendWebhook reports a 429 without Retry-After as null so SQL picks the delay",
  async function (): Promise<void> {
    const cases: Record<string, string>[] = [
      {},
      { "Retry-After": "soon" },
      { "Retry-After": "0" },
      { "Retry-After": "-30" },
      { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
    ];
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.ok, false);
      assertEquals(result.sent, 0);
      assertEquals(result.retryAfterSeconds, null);
      assertEquals("retryAfterSeconds" in result, true);
    }
    for (const headers of cases) {
      await withServer(
        () => new Response(null, { status: 429, headers }),
        send,
      );
    }
  },
);

Deno.test(
  "sendWebhook does not follow redirects and reports them as failures",
  async function (): Promise<void> {
    let followed = false;
    function receive(req: Request): Response {
      if (new URL(req.url).pathname === "/elsewhere") {
        followed = true;
        return new Response("ok");
      }
      return new Response(null, { status: 302, headers: { Location: "/elsewhere" } });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.ok, false);
      assertEquals(followed, false);
      assertMatch(errorText(result), /redirect/i);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendDiscord does not follow redirects",
  async function (): Promise<void> {
    let followed = false;
    function receive(req: Request): Response {
      if (new URL(req.url).pathname === "/elsewhere") {
        followed = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 301, headers: { Location: "/elsewhere" } });
    }
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/api/webhooks/1/abc`, "discord");
      const result = await sendDiscord(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.ok, false);
      assertEquals(followed, false);
      assertMatch(errorText(result), /redirect/i);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendWebhook refuses an unsafe destination before connecting",
  async function (): Promise<void> {
    let called = false;
    function receive(): Response {
      called = true;
      return new Response("ok");
    }
    async function send(base: string): Promise<void> {
      // Not allowInsecure: a plain-http loopback URL must be refused by the safety check.
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], {});
      assertEquals(result.ok, false);
      assertEquals(called, false);
    }
    await withServer(receive, send);
  },
);

// The pin: a webhook connects to an address urlsafety checked, never to a
// second resolution of the name (DNS rebinding).

interface Post {
  url: string;
  address: string;
  headers: Array<[string, string]>;
  body: string;
}

/** A pinnedPost stand-in that records where each request would connect. */
function recordingPost(
  posts: Post[],
  answer: (address: string) => number | Error,
): typeof pinnedPost {
  function post(url: URL, address: string, init: PinnedPostInit): Promise<PinnedResponse> {
    let headers: Array<[string, string]>;
    if (Array.isArray(init.headers)) {
      headers = (init.headers as ReadonlyArray<readonly [string, string]>).map((
        pair,
      ): [string, string] => [pair[0], pair[1]]);
    } else {
      headers = Object.entries(init.headers);
    }
    posts.push({ url: url.href, address, headers, body: String(init.body) });
    const result = answer(address);
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve({ status: result, headers: new Headers() });
  }
  return post;
}

Deno.test(
  "sendWebhook connects to the address it checked and resolves the name once",
  async function (): Promise<void> {
    let lookups = 0;
    function resolver(host: string): Promise<string[]> {
      lookups++;
      assertEquals(host, "hooks.example.com");
      return Promise.resolve(["93.184.216.34", "2606:2800:220:1::1"]);
    }
    const posts: Post[] = [];
    const d = dest("https://hooks.example.com/spots?k=1", "webhook");
    const result = await sendWebhook(
      d,
      Array.from({ length: 60 }, (_, i) => delivery(i + 1, d)),
      {
        resolver,
        webhookPost: recordingPost(posts, () => 200),
      },
    );
    assertEquals(result, { ok: true, sent: 60, attempted: 60, status: 200 });
    assertEquals(lookups, 1);
    assertEquals(posts.map((p) => [p.url, p.address]), [
      ["https://hooks.example.com/spots?k=1", "93.184.216.34"],
      ["https://hooks.example.com/spots?k=1", "93.184.216.34"],
    ]);
    assertEquals(posts[0]!.headers.map((header) => header[0]).sort(), [
      "Accept",
      "Content-Type",
      "User-Agent",
      "X-LongLines-Signature",
      "X-LongLines-Timestamp",
    ]);
  },
);

Deno.test(
  "sendWebhook refuses a name that resolves to a private address before connecting",
  async function (): Promise<void> {
    const posts: Post[] = [];
    const d = dest("https://rebind.example.com/spots", "webhook");
    const result = await sendWebhook(d, [delivery(1, d)], {
      resolver: () => Promise.resolve(["93.184.216.34", "127.0.0.1"]),
      webhookPost: recordingPost(posts, () => 200),
    });
    assertEquals(result, {
      ok: false,
      sent: 0,
      attempted: 1,
      error: "rebind.example.com resolves to a private address",
    });
    assertEquals(posts, []);
  },
);

Deno.test(
  "sendWebhook uses an IP literal as its own address without resolving",
  async function (): Promise<void> {
    const posts: Post[] = [];
    const d = dest("https://[2606:2800:220:1::1]:8443/spots", "webhook");
    const result = await sendWebhook(d, [delivery(1, d)], {
      resolver: () => Promise.reject(new Error("must not resolve")),
      webhookPost: recordingPost(posts, () => 200),
    });
    assertEquals(result, { ok: true, sent: 1, attempted: 1, status: 200 });
    assertEquals(posts.map((p) => p.address), ["2606:2800:220:1::1"]);
  },
);

Deno.test(
  "sendWebhook tries the next checked address only when connecting fails",
  async function (): Promise<void> {
    function resolver(): Promise<string[]> {
      return Promise.resolve(["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]);
    }
    const d = dest("https://hooks.example.com/spots", "webhook");
    const batch = Array.from({ length: 60 }, (_, i) => delivery(i + 1, d));

    // Refused on the first: the second takes both payloads.
    const posts: Post[] = [];
    function refusedFirst(a: string): number | Error {
      if (a === "192.0.2.1") {
        return new PinnedConnectError("Connection refused", { cause: undefined });
      }
      return 200;
    }
    assertEquals(
      await sendWebhook(d, batch, { resolver, webhookPost: recordingPost(posts, refusedFirst) }),
      { ok: true, sent: 60, attempted: 60, status: 200 },
    );
    assertEquals(posts.map((p) => p.address), ["192.0.2.1", "192.0.2.2", "192.0.2.2"]);

    // Refused everywhere: at most three addresses, then the last error.
    const all: Post[] = [];
    function refused(): Error {
      return new PinnedConnectError("Connection refused", { cause: undefined });
    }
    assertEquals(
      await sendWebhook(d, batch, { resolver, webhookPost: recordingPost(all, refused) }),
      { ok: false, sent: 0, attempted: 50, error: "Webhook request failed: Connection refused" },
    );
    assertEquals(all.map((p) => p.address), ["192.0.2.1", "192.0.2.2", "192.0.2.3"]);

    // Anything after connecting may have reached the receiver: no second try.
    const once: Post[] = [];
    function timedOut(): Error {
      return new PinnedHttpError("timed out after 10000 ms", { cause: undefined });
    }
    assertEquals(
      await sendWebhook(d, batch, { resolver, webhookPost: recordingPost(once, timedOut) }),
      {
        ok: false,
        sent: 0,
        attempted: 50,
        error: "Webhook request failed: timed out after 10000 ms",
      },
    );
    assertEquals(once.map((p) => p.address), ["192.0.2.1"]);
  },
);

Deno.test(
  "sendWebhook with allowInsecure connects to a name itself, trying both loopbacks",
  async function (): Promise<void> {
    const posts: Post[] = [];
    function v4Refused(a: string): number | Error {
      if (a === "127.0.0.1") {
        return new PinnedConnectError("Connection refused", { cause: undefined });
      }
      return 204;
    }
    const local = dest("http://localhost:9999/spots", "webhook");
    assertEquals(
      await sendWebhook(local, [delivery(1, local)], {
        allowInsecure: true,
        webhookPost: recordingPost(posts, v4Refused),
      }),
      { ok: true, sent: 1, attempted: 1, status: 204 },
    );
    const named = dest("http://receiver.test:9999/spots", "webhook");
    await sendWebhook(named, [delivery(1, named)], {
      allowInsecure: true,
      resolver: () => Promise.reject(new Error("must not resolve")),
      webhookPost: recordingPost(posts, () => 200),
    });
    assertEquals(posts.map((p) => p.address), ["127.0.0.1", "::1", "receiver.test"]);
  },
);

Deno.test(
  "sendWebhook with allowInsecure reports a URL it cannot parse",
  async function (): Promise<void> {
    const d = dest("not a url", "webhook");
    assertEquals(await sendWebhook(d, [delivery(1, d)], { allowInsecure: true }), {
      ok: false,
      sent: 0,
      attempted: 1,
      error: "Use an https URL.",
    });
  },
);

Deno.test(
  "sendWebhook reports a refused connection to a local receiver",
  async function (): Promise<void> {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = listener.addr.port;
    listener.close();
    const d = dest(`http://127.0.0.1:${port}/spots`, "webhook");
    const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
    assertEquals(result.ok, false);
    assertMatch(errorText(result), /^Webhook request failed: /);
  },
);

// --- webhook bodies rendered by SQL -------------------------------------

/** A webhook destination as the migrated claim hands it over. */
function webhookDest(
  url: string,
  batch_seconds: number,
  headers: Array<{ name: string; value: string }>,
): DeliveryDestination {
  const d = dest(url, "webhook");
  d.webhook = { batch_seconds, headers };
  return d;
}

/** A delivery carrying SQL's ordered pairs and the connection's name. */
function renderedWebhook(id: number, destination: DeliveryDestination): PendingDelivery {
  const d = delivery(id, destination);
  d.spot.webhook_connection = "Parks";
  d.spot.webhook_fields = [
    { key: "id", value: id },
    { key: "time", value: "2026-10-05T14:32:08Z" },
    { key: "callsign", value: "KK4PWJ" },
    { key: "frequency_khz", value: 14062 },
  ];
  return d;
}

/**
 * A receiver on a bare TCP socket, so a test sees the request head exactly as
 * sent (Deno.serve's Headers reorders). Answers each request with `statuses`
 * in turn (then 204).
 */
async function withRawServer(
  statuses: number[],
  fn: (base: string, requests: Array<{ head: string[]; body: string }>) => Promise<void>,
): Promise<void> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const requests: Array<{ head: string[]; body: string }> = [];
  async function serve(): Promise<void> {
    for await (const conn of listener) {
      let text = "";
      const buf = new Uint8Array(65536);
      for (;;) {
        const n = await conn.read(buf);
        if (n === null) {
          break;
        }
        text += new TextDecoder().decode(buf.subarray(0, n));
        const end = text.indexOf("\r\n\r\n");
        if (end < 0) {
          continue;
        }
        let length = 0;
        const match = /\r\ncontent-length: *(\d+)/i.exec(text);
        if (match !== null && match[1] !== undefined) {
          length = Number(match[1]);
        }
        if (text.length >= end + 4 + length) {
          break;
        }
      }
      const end = text.indexOf("\r\n\r\n");
      requests.push({ head: text.slice(0, end).split("\r\n"), body: text.slice(end + 4) });
      let status = 204;
      const planned = statuses[requests.length - 1];
      if (planned !== undefined) {
        status = planned;
      }
      await conn.write(
        new TextEncoder().encode(
          `HTTP/1.1 ${status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        ),
      );
      conn.close();
    }
  }
  // The accept loop may reject once the listener closes; that is expected.
  function ignoreClosed(): void {}
  const serving = serve();
  try {
    await fn(`http://127.0.0.1:${listener.addr.port}`, requests);
  } finally {
    listener.close();
    await serving.catch(ignoreClosed);
  }
}

function headerNames(head: string[]): Array<string | undefined> {
  return head.slice(1).map((line) => line.split(":")[0]);
}

Deno.test(
  "sendWebhook sends the headers in order: Host, the fixed five, the test marker, the extras",
  async function (): Promise<void> {
    await withRawServer([204], async function (base, requests): Promise<void> {
      const d = webhookDest(`${base}/hook/abc`, 0, [
        { name: "Authorization", value: "Bearer abc" },
        { name: "Content-Type", value: "text/plain" },
        { name: "X-Api-Key", value: "k1" },
      ]);
      const test = renderedWebhook(1, d);
      test.test = true;
      const result = await sendWebhook(d, [test], { allowInsecure: true });
      assertEquals(result, { ok: true, sent: 1, attempted: 1, status: 204 });
      const request = requests[0]!;
      assertEquals(request.head[0], "POST /hook/abc HTTP/1.1");
      assertEquals(headerNames(request.head), [
        "Host",
        "Accept",
        "Content-Type",
        "User-Agent",
        "X-LongLines-Timestamp",
        "X-LongLines-Signature",
        "X-LongLines-Test",
        "Authorization",
        "X-Api-Key",
        "Content-Length",
        "Connection",
      ]);
      assertEquals(request.head.includes("Content-Type: application/json"), true);
      assertEquals(request.head.includes("Content-Type: text/plain"), false);
      assertEquals(request.head.includes("X-LongLines-Test: true"), true);
      assertEquals(request.head.includes("Authorization: Bearer abc"), true);
      let tsText: string | undefined;
      const match = /^X-LongLines-Timestamp: (\d+)$/m.exec(request.head.join("\n"));
      if (match !== null) {
        tsText = match[1];
      }
      const ts = Number(tsText);
      assertEquals(
        request.head.includes(
          `X-LongLines-Signature: ${await signWebhookBody("whsec_testsecret", ts, request.body)}`,
        ),
        true,
      );
      assertEquals(
        request.body,
        '{"delivery_id":1,"connection":"Parks","spot":{"id":1,"time":"2026-10-05T14:32:08Z",' +
          '"callsign":"KK4PWJ","frequency_khz":14062}}',
      );
    });
  },
);

Deno.test(
  "sendWebhook leaves out the test marker on a real delivery",
  async function (): Promise<void> {
    await withRawServer([204], async function (base, requests): Promise<void> {
      const d = webhookDest(`${base}/hook`, 0, []);
      await sendWebhook(d, [renderedWebhook(1, d)], { allowInsecure: true });
      assertEquals(headerNames(requests[0]!.head).includes("X-LongLines-Test"), false);
    });
  },
);

Deno.test(
  "sendWebhook sends one request per spot at batch 0 and stops at the first failure",
  async function (): Promise<void> {
    await withRawServer([204, 204, 500], async function (base, requests): Promise<void> {
      const d = webhookDest(`${base}/hook`, 0, []);
      const batch = [1, 2, 3, 4, 5].map((id) => renderedWebhook(id, d));
      const result = await sendWebhook(d, batch, { allowInsecure: true });
      assertEquals(result, {
        ok: false,
        sent: 2,
        attempted: 3,
        status: 500,
        error: "Webhook HTTP 500",
      });
      assertEquals(requests.map((r) => JSON.parse(r.body).delivery_id), [1, 2, 3]);
    });
    await withRawServer([], async function (base, requests): Promise<void> {
      const d = webhookDest(`${base}/hook`, 0, []);
      const batch = [1, 2, 3, 4, 5].map((id) => renderedWebhook(id, d));
      assertEquals(await sendWebhook(d, batch, { allowInsecure: true }), {
        ok: true,
        sent: 5,
        attempted: 5,
        status: 204,
      });
      assertEquals(requests.length, 5);
    });
  },
);

Deno.test(
  "sendWebhook groups into spots lists of 50 and counts a failed group as attempted",
  async function (): Promise<void> {
    await withRawServer([204, 500], async function (base, requests): Promise<void> {
      const d = webhookDest(`${base}/hook`, 30, []);
      const batch = Array.from({ length: 120 }, (_, i) => renderedWebhook(i + 1, d));
      const result = await sendWebhook(d, batch, { allowInsecure: true });
      assertEquals(result, {
        ok: false,
        sent: 50,
        attempted: 100,
        status: 500,
        error: "Webhook HTTP 500",
      });
      assertEquals(requests.map((r) => JSON.parse(r.body).spots.length), [50, 50]);
    });
  },
);

Deno.test(
  "sendWebhook reports the status of a 429 with the throttle",
  async function (): Promise<void> {
    await withRawServer([429], async function (base): Promise<void> {
      const d = webhookDest(`${base}/hook`, 0, []);
      const result = await sendWebhook(d, [renderedWebhook(1, d)], { allowInsecure: true });
      assertEquals(result.status, 429);
      assertEquals(result.retryAfterSeconds, null);
      assertEquals(result.attempted, 1);
    });
  },
);

Deno.test(
  "sendWebhook rethrows what pinnedPost never throws, for runDeliveryBatch to fail the batch",
  async function (): Promise<void> {
    const d = webhookDest("https://hooks.example.com/hook", 0, []);
    function bug(): Error {
      return new TypeError("bug in the request");
    }
    await assertRejects(
      () =>
        sendWebhook(d, [renderedWebhook(1, d)], {
          resolver: () => Promise.resolve(["93.184.216.34"]),
          webhookPost: recordingPost([], bug),
        }),
      TypeError,
      "bug in the request",
    );
  },
);

Deno.test(
  "sendWebhook reports the last status received when a later request fails to connect",
  async function (): Promise<void> {
    const d = webhookDest("https://hooks.example.com/hook", 0, []);
    let n = 0;
    function answer(): number | Error {
      n++;
      if (n === 1) {
        return 202;
      }
      return new PinnedConnectError("reset", { cause: undefined });
    }
    const result = await sendWebhook(d, [renderedWebhook(1, d), renderedWebhook(2, d)], {
      resolver: () => Promise.resolve(["93.184.216.34"]),
      webhookPost: recordingPost([], answer),
    });
    assertEquals(result, {
      ok: false,
      sent: 1,
      attempted: 2,
      status: 202,
      error: "Webhook request failed: reset",
    });
  },
);

// --- push ---------------------------------------------------------------

// The RFC 8291 user agent keys, so the test can decrypt what a device receives.
const UA = {
  public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
};

let vapidKeys: VapidKeys | undefined;
async function vapid(): Promise<VapidKeys> {
  if (vapidKeys) {
    return vapidKeys;
  }
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  let privateKey = "";
  if (jwk.d !== undefined) {
    privateKey = jwk.d;
  }
  vapidKeys = {
    publicKey: base64UrlEncode(raw),
    privateKey,
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
  let infoBytes: Uint8Array<ArrayBuffer>;
  if (typeof info === "string") {
    infoBytes = new TextEncoder().encode(info);
  } else {
    infoBytes = info;
  }
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: infoBytes },
      key,
      bytes * 8,
    ),
  );
}

/** A raw P-256 public point as a JWK. */
function point(raw: Uint8Array): JsonWebKey {
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(raw.slice(1, 33)),
    y: base64UrlEncode(raw.slice(33, 65)),
  };
}

/** What the browser does with an aes128gcm body (RFC 8291 from the receiving side). */
async function decrypt(body: Uint8Array<ArrayBuffer>): Promise<PushNotification> {
  const salt = body.slice(0, 16);
  const asPublic = body.slice(21, 21 + body[20]!);
  const uaPublic = base64UrlDecode(UA.public);
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const uaJwk = point(uaPublic);
  uaJwk.d = UA.private;
  const uaPrivate = await crypto.subtle.importKey(
    "jwk",
    uaJwk,
    ecdh,
    false,
    ["deriveBits"],
  );
  const asKey = await crypto.subtle.importKey("jwk", point(asPublic), ecdh, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256),
  );
  const label = new TextEncoder().encode("WebPush: info\0");
  const info = new Uint8Array(label.length + uaPublic.length + asPublic.length);
  info.set(label, 0);
  info.set(uaPublic, label.length);
  info.set(asPublic, label.length + uaPublic.length);
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
  async function receive(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const seen = requests.filter((r) => r.path === path).length;
    requests.push({ path, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    let segment = "";
    const first = path.split("/")[1];
    if (first !== undefined) {
      segment = first;
    }
    const statuses = segment.split(",");
    const status = Number(statuses[Math.min(seen, statuses.length - 1)]);
    if (status === 301) {
      return new Response(null, { status, headers: { Location: "/201/x" } });
    }
    if (status === 429) {
      return new Response(null, { status, headers: { "Retry-After": "42" } });
    }
    return new Response(null, { status });
  }
  await withServer(receive, (base) => fn(base, requests));
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

Deno.test(
  "sendPush encrypts one notification per spot to a device, with the legacy headers when the claim carried no settings",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const d = pushDest([device(base, "/201/a")]);
      const batch = Array.from({ length: 5 }, (_, i) => delivery(i + 1, d));
      batch[1]!.spot.callsign = "W4/KK4PWJ/P";
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
      assertEquals(notes[0]!.url, "/call/KK4PWJ");
      assertEquals(notes[0]!.title, "KK4PWJ");

      const h = requests[1]!.headers;
      assertEquals(h.get("ttl"), "900");
      assertEquals(h.get("urgency"), "high");
      assertEquals(h.get("topic"), "spotW4_KK4PWJ_P");
      assertEquals(h.get("content-encoding"), "aes128gcm");
      assertEquals(h.get("content-type"), "application/octet-stream");
      assertMatch(headerText(h, "user-agent"), /^LongLines\//);
      assertMatch(
        headerText(h, "authorization"),
        /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B[\w-]+$/,
      );
    });
  },
);

Deno.test(
  "sendPush sends the destination's urgency and TTL and SQL's text",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const d = pushDest([device(base, "/201/a")]);
      const settings = structuredClone(PUSH_SETTINGS);
      settings.urgency = "low";
      settings.ttl_seconds = 14400;
      d.push = settings;
      const row = delivery(1, d);
      row.spot.push_title = "KK4PWJ · 14.062 MHz · CW";
      row.spot.push_body = "POTA · US-2763 · Eno River State Park · NC";
      row.spot.push_url = "/call/KK4PWJ";
      row.spot.push_source_url = "https://pota.app/#/park/US-2763";
      const result = await sendPush(d, [row], { allowInsecure: true, vapid: await vapid() });
      assertEquals(result.ok, true);
      assertEquals(requests.length, 1);
      assertEquals(requests[0]!.headers.get("ttl"), "14400");
      assertEquals(requests[0]!.headers.get("urgency"), "low");
      const note = await decrypt(requests[0]!.body);
      assertEquals(note.title, "KK4PWJ · 14.062 MHz · CW");
      assertEquals(note.body, "POTA · US-2763 · Eno River State Park · NC");
      assertEquals(note.actions!.map((a) => a.title), ["Open profile", "Open on POTA"]);
      assertEquals(note.silent, false);
    });
  },
);

Deno.test(
  "sendPush in quiet hours set to Don't send makes no request and reports the batch sent",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const d = pushDest([device(base, "/201/a")]);
      const settings = structuredClone(PUSH_SETTINGS);
      settings.quiet_mode = "skip";
      d.push = settings;
      d.quiet_now = true;
      const batch = [delivery(1, d), delivery(2, d)];
      // No VAPID keys and no devices needed: nothing is sent and nothing is reported per device.
      const noDevices = structuredClone(d);
      noDevices.devices = [];
      assertEquals(await sendPush(noDevices, batch, { allowInsecure: true }), {
        ok: true,
        sent: 2,
      });
      assertEquals(await sendPush(d, batch, { allowInsecure: true, vapid: await vapid() }), {
        ok: true,
        sent: 2,
      });
      assertEquals(requests.length, 0);
    });
  },
);

Deno.test(
  "sendPush in quiet hours set to Send silently still sends, silently",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const d = pushDest([device(base, "/201/a")]);
      d.push = PUSH_SETTINGS;
      d.quiet_now = true;
      const result = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.ok, true);
      assertEquals(requests.length, 1);
      const note = await decrypt(requests[0]!.body);
      assertEquals([note.silent, note.renotify], [true, false]);
    });
  },
);

Deno.test(
  "sendPush counts the batch sent when one device accepts and reports gone ones",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
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
        deviceResults: {
          ok: [`${base}/202/ok`],
          errors: { [`${base}/500/bad`]: "Push HTTP 500" },
        },
      });
      // A device stops at its first refusal; the accepting one gets both spots.
      assertEquals(requests.filter((r) => r.path === "/202/ok").length, 2);
      assertEquals(requests.filter((r) => r.path === "/410/gone").length, 1);
      assertEquals(requests.filter((r) => r.path === "/500/bad").length, 1);
    });
  },
);

Deno.test(
  "sendPush fails the batch when no device accepts",
  async function (): Promise<void> {
    await withPushServer(async function (base): Promise<void> {
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
  },
);

Deno.test(
  "sendPush with every device gone asks for a device",
  async function (): Promise<void> {
    await withPushServer(async function (base): Promise<void> {
      const d = pushDest([device(base, "/410/a"), device(base, "/404/b")]);
      const result = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.ok, false);
      assertEquals(result.error, "Turn on notifications on a device first.");
      assertEquals(result.expiredEndpoints, [`${base}/410/a`, `${base}/404/b`]);
    });
  },
);

Deno.test(
  "sendWebhook caps a huge Retry-After at a day so the throttle still fits an int",
  async function (): Promise<void> {
    async function send(base: string): Promise<void> {
      const d = dest(`${base}/spots`, "webhook");
      const result = await sendWebhook(d, [delivery(1, d)], { allowInsecure: true });
      assertEquals(result.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
    }
    await withServer(
      () => new Response(null, { status: 429, headers: { "Retry-After": "3000000000" } }),
      send,
    );
  },
);

Deno.test(
  "sendPush caps a huge Retry-After at a day and passes null without a usable one",
  async function (): Promise<void> {
    // Null, so throttle_destination picks the level's backoff.
    const cases: Array<[Record<string, string>, number | null]> = [
      [{ "Retry-After": "3000000000" }, MAX_RETRY_AFTER_SECONDS],
      [{ "Retry-After": "0" }, null],
      [{ "Retry-After": "soon" }, null],
      [{}, null],
    ];
    async function send(base: string, expected: number | null): Promise<void> {
      const d = pushDest([device(base, "/a")]);
      const result = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.retryAfterSeconds, expected);
      assertEquals(result.error, "Push HTTP 429 (rate limited)");
    }
    for (const c of cases) {
      const headers = c[0];
      const expected = c[1];
      await withServer(
        () => new Response(null, { status: 429, headers }),
        (base) => send(base, expected),
      );
    }
  },
);

Deno.test(
  "sendPush takes the longest Retry-After any rate-limited device gave",
  async function (): Promise<void> {
    function receive(req: Request): Response {
      const path = new URL(req.url).pathname;
      let headers: Record<string, string> = {};
      if (path === "/a") {
        headers = { "Retry-After": "42" };
      }
      return new Response(null, { status: 429, headers });
    }
    async function send(base: string): Promise<void> {
      const d = pushDest([device(base, "/b"), device(base, "/a")]);
      const result = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.ok, false);
      assertEquals(result.retryAfterSeconds, 42);
    }
    await withServer(receive, send);
  },
);

Deno.test(
  "sendPush treats a 429 as a rate limit, not a failure",
  async function (): Promise<void> {
    await withPushServer(async function (base): Promise<void> {
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
  },
);

Deno.test(
  "sendPush records a rate-limited device when another device took the batch",
  async function (): Promise<void> {
    await withPushServer(async function (base): Promise<void> {
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
  },
);

Deno.test(
  "sendPush does not retry a batch a device already started showing",
  async function (): Promise<void> {
    // Retrying would show the accepted notifications again on every attempt.
    async function send(path: string, base: string, requests: PushRequest[]): Promise<void> {
      const d = pushDest([device(base, path)]);
      const result = await sendPush(d, [delivery(1, d), delivery(2, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.ok, true, path);
      assertEquals(result.sent, 2);
      assertEquals(result.retryAfterSeconds, undefined);
      assertEquals(result.deviceResults!.ok, []);
      let error = "";
      const deviceError = result.deviceResults!.errors[`${base}${path}`];
      if (deviceError !== undefined) {
        error = deviceError;
      }
      assertMatch(error, /^Push HTTP (500|429)/);
      assertEquals(requests.length, 2);
    }
    for (const path of ["/201,500/a", "/201,429/a"]) {
      await withPushServer((base, requests) => send(path, base, requests));
    }
  },
);

Deno.test(
  "sendPush reports a bad VAPID key as server configuration, not a device fault",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const d = pushDest([device(base, "/201/a"), device(base, "/201/b")]);
      const keys = await vapid();
      const result = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: { publicKey: keys.publicKey, privateKey: "short", subject: keys.subject },
      });
      assertEquals(result, { ok: false, sent: 0, error: "Push isn't configured on the server." });
      // A JWK-form key that is not JSON reads the same.
      const jwk = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: { publicKey: keys.publicKey, privateKey: "{not json", subject: keys.subject },
      });
      assertEquals(jwk, { ok: false, sent: 0, error: "Push isn't configured on the server." });
      assertEquals(requests, []);
    });
  },
);

Deno.test(
  "sendPush reports a device's malformed subscription keys on that device alone",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const bad = { endpoint: `${base}/201/bad`, p256dh: "AAAA", auth: UA.auth };
      const d = pushDest([bad, device(base, "/201/good")]);
      const result = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.ok, true);
      assertEquals(result.deviceResults, {
        ok: [`${base}/201/good`],
        errors: { [`${base}/201/bad`]: "Subscription p256dh must be an uncompressed P-256 key" },
      });
      assertEquals(requests.map((r) => r.path), ["/201/good"]);
    });
  },
);

Deno.test(
  "sendPush signs one VAPID JWT per origin with the pinned clock",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
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
  },
);

Deno.test(
  "sendPush does not follow redirects",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const d = pushDest([device(base, "/301/a")]);
      const result = await sendPush(d, [delivery(1, d)], {
        allowInsecure: true,
        vapid: await vapid(),
      });
      assertEquals(result.ok, false);
      assertMatch(errorText(result), /redirect/i);
      assertEquals(requests.map((r) => r.path), ["/301/a"]);
    });
  },
);

Deno.test(
  "sendPush reports a network error per device",
  async function (): Promise<void> {
    const d = pushDest([{ endpoint: "http://127.0.0.1:9/x", p256dh: UA.public, auth: UA.auth }]);
    const result = await sendPush(d, [delivery(1, d)], {
      allowInsecure: true,
      vapid: await vapid(),
    });
    assertEquals(result.ok, false);
    assertMatch(errorText(result), /^Push request failed: /);
  },
);

Deno.test(
  "sendPush checks the endpoint allowlist before connecting",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const d = pushDest([device(base, "/201/a")]);
      const result = await sendPush(d, [delivery(1, d)], { vapid: await vapid() });
      assertEquals(result.ok, false);
      assertEquals(result.error, "Use a browser push service.");
      assertEquals(requests, []);
    });
  },
);

Deno.test(
  "sendPush needs a device and the VAPID keys",
  async function (): Promise<void> {
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
    assertEquals(await sendPush(unconfigured, [delivery(1, unconfigured)], {}), {
      ok: false,
      sent: 0,
      error: "Push isn't configured on the server.",
    });
  },
);

Deno.test(
  "sendToDestination picks the sender by type",
  async function (): Promise<void> {
    await withPushServer(async function (base, requests): Promise<void> {
      const p = pushDest([device(base, "/201/a")]);
      const options = { allowInsecure: true, vapid: await vapid() };
      assertEquals((await sendToDestination(p, [delivery(1, p)], options)).ok, true);
      const w = dest(`${base}/200/hook`, "webhook");
      assertEquals(await sendToDestination(w, [delivery(1, w)], options), {
        ok: true,
        sent: 1,
        attempted: 1,
        status: 200,
      });
      const c = dest(`${base}/204/api/webhooks/1/abc`, "discord");
      assertEquals(await sendToDestination(c, [delivery(1, c)], options), { ok: true, sent: 1 });
      assertEquals(requests.map((r) => r.path), [
        "/201/a",
        "/200/hook",
        "/204/api/webhooks/1/abc",
      ]);
    });
  },
);

Deno.test(
  "Discord and webhook sends refuse a destination without a URL",
  async function (): Promise<void> {
    const w = dest("x", "webhook");
    w.url = null;
    assertEquals((await sendWebhook(w, [delivery(1, w)], { allowInsecure: true })).ok, false);
    const c = dest("x", "discord");
    c.url = null;
    assertEquals((await sendDiscord(c, [delivery(1, c)], { allowInsecure: true })).ok, false);
  },
);
