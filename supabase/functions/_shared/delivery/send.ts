// HTTP delivery to Discord, webhooks and browser push services. Each function
// sends as much of the batch as it can, in order, and reports how many
// deliveries went out so the worker can mark exactly those as sent.

import { signWebhookBody } from "./hmac.ts";
import {
  DISCORD_MESSAGES_PER_RUN,
  discordBatches,
  pushNotifications,
  pushPayload,
  pushSettingsOf,
  pushSkipped,
  webhookExtraHeaders,
  webhookRequests,
} from "./format.ts";
import {
  assertSafeDestinationUrl,
  assertSafePushEndpoint,
  assertSafeResolvedHost,
  hostOf,
  type Resolver,
} from "./urlsafety.ts";
import { PinnedConnectError, pinnedPost, type PinnedResponse } from "./pinned_http.ts";
import { encryptPushPayload, vapidAuthorization, type VapidKeys } from "./webpush.ts";
import type { DeliveryDestination, PendingDelivery, PushDevice, PushSettings } from "./types.ts";

export const USER_AGENT = "LongLines/0.2";
export { DISCORD_MESSAGES_PER_RUN };
export const WEBHOOK_TIMEOUT_MS = 10_000;
const DISCORD_TIMEOUT_MS = 10_000;
const PUSH_TIMEOUT_MS = 10_000;
/** Longest Retry-After honoured: throttle_destination takes an int, and a day is plenty. */
export const MAX_RETRY_AFTER_SECONDS = 86_400;
const NO_DEVICES = "Turn on notifications on a device first.";
const NO_URL = "Destination has no URL";

export interface SendOptions {
  /** Tests only: skip URL safety so a loopback http server can stand in for the destination. */
  allowInsecure?: boolean;
  resolver?: Resolver;
  /** Tests only: stands in for pinnedPost, to see which address a webhook connects to. */
  webhookPost?: typeof pinnedPost;
  /** From LONGLINES_VAPID_* env; push sends fail without it. */
  vapid?: VapidKeys;
  /** Tests pin the clock that dates the VAPID JWT. */
  now?: Date;
}

/** Per-device status for record_push_results: endpoints that took everything, and errors. */
export interface PushDeviceResults {
  ok: string[];
  errors: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  /** Deliveries confirmed sent, counted from the start of the batch. */
  sent: number;
  error?: string;
  /**
   * Present when the rest should wait rather than count as a failure: the
   * service's Retry-After, or null when it gave none and SQL picks the delay.
   */
  retryAfterSeconds?: number | null;
  /** Push only: subscriptions the push service says are gone (404/410), to prune. */
  expiredEndpoints?: string[];
  /** Push only. */
  deviceResults?: PushDeviceResults;
  /** Webhook only: the last HTTP status received, absent when no request got one. */
  status?: number;
  /**
   * Webhook only: the deliveries up to and including the last request made
   * (on a failure, `sent` plus the failed request's count). Only these count
   * an attempt; the rest are left for the claim's visibility timeout. Absent
   * means the whole batch, as Discord and push report.
   */
  attempted?: number;
}

/**
 * The RPCs that follow a push send: prune subscriptions the push service says
 * are gone, then stamp each device's last success or error. Empty for the
 * other destination types. The sender and Send test both run them.
 */
export function pushBookkeeping(result: SendResult): Array<[string, Record<string, unknown>]> {
  const calls: Array<[string, Record<string, unknown>]> = [];
  if (result.expiredEndpoints !== undefined && result.expiredEndpoints.length > 0) {
    calls.push(["prune_push_devices", { p_endpoints: result.expiredEndpoints }]);
  }
  const devices = result.deviceResults;
  if (devices !== undefined && (devices.ok.length > 0 || Object.keys(devices.errors).length > 0)) {
    calls.push(["record_push_results", { p_ok: devices.ok, p_errors: devices.errors }]);
  }
  return calls;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Redirects are never followed: a safe public hostname could otherwise send
// us to an internal address after the URL check. With redirect: "manual" the
// runtime reports the 3xx itself (status 0 "opaqueredirect" in some runtimes).
function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

export async function sendDiscord(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
  options: SendOptions = {},
): Promise<SendResult> {
  if (destination.url === null) {
    return { ok: false, sent: 0, error: NO_URL };
  }
  if (options.allowInsecure !== true) {
    try {
      assertSafeDestinationUrl("discord", destination.url);
    } catch (error) {
      return { ok: false, sent: 0, error: errorMessage(error) };
    }
  }

  const batches = discordBatches(deliveries.map((d) => d.spot), destination);
  const url = new URL(destination.url);
  url.searchParams.set("wait", "false");
  let sent = 0;

  for (const entry of batches.entries()) {
    const index = entry[0];
    const message = entry[1].message;
    const spots = entry[1].spots;
    if (index >= DISCORD_MESSAGES_PER_RUN) {
      return {
        ok: false,
        sent,
        error: "Discord per-run message cap reached",
        retryAfterSeconds: 60,
      };
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (error) {
      return { ok: false, sent, error: `Discord request failed: ${errorMessage(error)}` };
    }
    if (isRedirect(response)) {
      if (response.body !== null) {
        await response.body.cancel();
      }
      return {
        ok: false,
        sent,
        error: `Discord redirected (HTTP ${String(response.status)}); redirects are not followed`,
      };
    }
    if (response.status === 429) {
      const retryAfter = await retryAfterSecondsOf(response);
      return {
        ok: false,
        sent,
        error: "Discord HTTP 429 (rate limited)",
        retryAfterSeconds: retryAfter,
      };
    }
    if (response.body !== null) {
      await response.body.cancel();
    }
    if (!response.ok) {
      return { ok: false, sent, error: `Discord HTTP ${String(response.status)}` };
    }
    sent += spots;
  }
  return { ok: true, sent };
}

/**
 * A Retry-After value (header text, or a number from a JSON body) in whole
 * seconds, capped at MAX_RETRY_AFTER_SECONDS; null when it is not a positive
 * number. An HTTP-date reads as null and the caller's fallback applies.
 */
export function retryAfterSeconds(value: unknown): number | null {
  let seconds: number;
  if (typeof value === "number") {
    seconds = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    seconds = Number(value);
  } else {
    seconds = NaN;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
}

/**
 * Discord reports retry_after in seconds (fractional) in the body, or a
 * Retry-After header; null when it gave neither, so SQL picks the delay.
 */
async function retryAfterSecondsOf(response: Response): Promise<number | null> {
  const header = response.headers.get("retry-after");
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // no JSON body
  }
  let fromBody: unknown = undefined;
  if (typeof body === "object" && body !== null) {
    fromBody = (body as { retry_after?: unknown }).retry_after;
  }
  const bodySeconds = retryAfterSeconds(fromBody);
  if (bodySeconds !== null) {
    return bodySeconds;
  }
  return retryAfterSeconds(header);
}

/** Checked addresses a webhook send tries, in order, when connecting is refused. */
const WEBHOOK_MAX_ADDRESSES = 3;

/**
 * The URL and the addresses to connect to. Safe sends get the addresses
 * urlsafety checked, so the name is resolved once and never again (DNS
 * rebinding). allowInsecure skips the checks and lets Deno.connect resolve
 * the name, as fetch did.
 */
async function webhookTarget(
  rawUrl: string,
  options: SendOptions,
): Promise<{ url: URL; addresses: string[] }> {
  if (options.allowInsecure === true) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Use an https URL.");
    }
    const host = hostOf(url);
    // Deno.connect takes only the first answer for a name; fetch tried both loopbacks.
    const loopback = host === "localhost" || host.endsWith(".localhost");
    let addresses = [host];
    if (loopback) {
      addresses = ["127.0.0.1", "::1"];
    }
    return { url, addresses };
  }
  const url = assertSafeDestinationUrl("webhook", rawUrl);
  const addresses = await assertSafeResolvedHost(hostOf(url), options.resolver);
  return { url, addresses: addresses.slice(0, WEBHOOK_MAX_ADDRESSES) };
}

/**
 * Sends each of the run's requests (webhookRequests: SQL's rendered body, or
 * the legacy one), one after another, stopping at the first that fails.
 * Headers go out as Host, the fixed five, X-LongLines-Test on a test, then the
 * destination's extra headers in position order (webhookExtraHeaders; none
 * can replace a fixed one). A failure before any request (an unsafe URL, no
 * signing secret) counts as the first request failing, so the destination's
 * health still moves.
 */
export async function sendWebhook(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
  options: SendOptions = {},
): Promise<SendResult> {
  const requests = webhookRequests(destination, deliveries);
  let firstCount = 0;
  const first = requests[0];
  if (first !== undefined) {
    firstCount = first.count;
  }
  if (destination.url === null) {
    return { ok: false, sent: 0, attempted: firstCount, error: NO_URL };
  }
  let target: { url: URL; addresses: string[] };
  try {
    target = await webhookTarget(destination.url, options);
  } catch (error) {
    return { ok: false, sent: 0, attempted: firstCount, error: errorMessage(error) };
  }
  if (
    destination.signing_secret === undefined || destination.signing_secret === null ||
    destination.signing_secret === ""
  ) {
    return {
      ok: false,
      sent: 0,
      attempted: firstCount,
      error: "Webhook destination has no signing secret",
    };
  }
  let post = pinnedPost;
  if (options.webhookPost !== undefined) {
    post = options.webhookPost;
  }
  const test = deliveries.some((d) => d.test === true);
  const extra = webhookExtraHeaders(destination).map((h): [string, string] => [h.name, h.value]);

  let sent = 0;
  let status: number | undefined;
  // Index of the address that last connected; a refused one moves to the next.
  let at = 0;
  for (const request of requests) {
    const attempted = sent + request.count;
    const body = JSON.stringify(request.body);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signWebhookBody(destination.signing_secret, timestamp, body);
    const headers: Array<[string, string]> = [
      ["Accept", "*/*"],
      ["Content-Type", "application/json"],
      ["User-Agent", USER_AGENT],
      ["X-LongLines-Timestamp", String(timestamp)],
      ["X-LongLines-Signature", signature],
    ];
    if (test) {
      headers.push(["X-LongLines-Test", "true"]);
    }
    for (const header of extra) {
      headers.push(header);
    }
    let response: PinnedResponse;
    try {
      for (;;) {
        try {
          const address = target.addresses[at];
          if (address === undefined) {
            throw new Error("sendWebhook: no address to connect to");
          }
          response = await post(target.url, address, {
            headers,
            body,
            timeoutMs: WEBHOOK_TIMEOUT_MS,
            allowInsecure: options.allowInsecure,
          });
          break;
        } catch (error) {
          // Nothing was sent when the connection itself failed, so another address is safe.
          if (!(error instanceof PinnedConnectError) || at + 1 >= target.addresses.length) {
            throw error;
          }
          at++;
        }
      }
    } catch (error) {
      return webhookFailure(
        sent,
        attempted,
        status,
        `Webhook request failed: ${errorMessage(error)}`,
      );
    }
    status = response.status;
    if (response.status >= 300 && response.status < 400) {
      return webhookFailure(
        sent,
        attempted,
        status,
        `Webhook redirected (HTTP ${String(response.status)}); redirects are not followed`,
      );
    }
    if (response.status === 429) {
      // Alive, just too fast: the destination is throttled, never failed.
      return webhookFailure(sent, attempted, status, "Webhook HTTP 429 (rate limited)", {
        retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return webhookFailure(sent, attempted, status, `Webhook HTTP ${String(response.status)}`);
    }
    sent += request.count;
  }
  const result: SendResult = { ok: true, sent, attempted: sent };
  if (status !== undefined) {
    result.status = status;
  }
  return result;
}

/**
 * A failed webhook send's result: status only when a request got one, and
 * retryAfterSeconds only with a throttle (a 429).
 */
function webhookFailure(
  sent: number,
  attempted: number,
  status: number | undefined,
  error: string,
  throttle: { retryAfterSeconds: number | null } | null = null,
): SendResult {
  const result: SendResult = { ok: false, sent, attempted, error };
  if (throttle !== null) {
    result.retryAfterSeconds = throttle.retryAfterSeconds;
  }
  if (status !== undefined) {
    result.status = status;
  }
  return result;
}

/** Send with the function that matches the destination's type. */
export function sendToDestination(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
  options: SendOptions = {},
): Promise<SendResult> {
  switch (destination.type) {
    case "discord":
      return sendDiscord(destination, deliveries, options);
    case "webhook":
      return sendWebhook(destination, deliveries, options);
    case "push":
      return sendPush(destination, deliveries, options);
  }
}

/** How one device's run ended, and how many notifications it took before that. */
type DeviceOutcome =
  & { accepted: number }
  & (
    | { kind: "accepted" }
    | { kind: "gone" }
    | { kind: "rate_limited"; retryAfterSeconds: number | null }
    | { kind: "error"; error: string }
  );

const RATE_LIMITED = "Push HTTP 429 (rate limited)";

/** Push's Topic header allows at most 32 characters of the URL-safe base64 alphabet. */
export function pushTopic(tag: string): string {
  return tag.replace(/:/g, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
}

/** Sends every notification to one device, in order, stopping at its first refusal. */
async function pushToDevice(
  device: PushDevice,
  payloads: readonly Uint8Array[],
  topics: readonly string[],
  authorization: (endpoint: string) => string | undefined,
  settings: PushSettings,
  options: SendOptions,
): Promise<DeviceOutcome> {
  let accepted = 0;
  try {
    if (options.allowInsecure !== true) {
      assertSafePushEndpoint(device.endpoint);
    }
    const vapid = authorization(device.endpoint);
    if (vapid === undefined) {
      throw new Error("Use a browser push service.");
    }
    for (const entry of payloads.entries()) {
      const index = entry[0];
      const payload = entry[1];
      const body = await encryptPushPayload(payload, device);
      let topic = "";
      const indexedTopic = topics[index];
      if (indexedTopic !== undefined) {
        topic = indexedTopic;
      }
      let response: Response;
      try {
        response = await fetch(device.endpoint, {
          method: "POST",
          headers: {
            "Authorization": vapid,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": String(settings.ttl_seconds),
            "Urgency": settings.urgency,
            "Topic": topic,
            "User-Agent": USER_AGENT,
          },
          body,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          redirect: "manual",
        });
      } catch (error) {
        return { kind: "error", accepted, error: `Push request failed: ${errorMessage(error)}` };
      }
      if (response.body !== null) {
        await response.body.cancel();
      }
      if (isRedirect(response)) {
        return {
          kind: "error",
          accepted,
          error: `Push redirected (HTTP ${String(response.status)}); redirects are not followed`,
        };
      }
      if (response.status === 404 || response.status === 410) {
        return { kind: "gone", accepted };
      }
      if (response.status === 429) {
        return {
          kind: "rate_limited",
          accepted,
          // Null without a Retry-After, so SQL picks the level's backoff.
          retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
        };
      }
      if (response.status !== 201 && response.status !== 202) {
        return { kind: "error", accepted, error: `Push HTTP ${String(response.status)}` };
      }
      accepted++;
    }
    return { kind: "accepted", accepted };
  } catch (error) {
    return { kind: "error", accepted, error: errorMessage(error) };
  }
}

/**
 * One VAPID header per push-service origin, signed before anything is sent so
 * a bad key reads as server configuration rather than a fault on every device.
 * Null when the key cannot sign; endpoints that are not URLs get no entry.
 */
async function vapidHeaders(
  devices: readonly PushDevice[],
  vapid: VapidKeys,
  now: Date,
): Promise<Map<string, string> | null> {
  const headers = new Map<string, string>();
  for (const device of devices) {
    let origin: string;
    try {
      origin = new URL(device.endpoint).origin;
    } catch {
      continue; // the device's own allowlist check reports it
    }
    if (headers.has(origin)) {
      continue;
    }
    try {
      headers.set(origin, await vapidAuthorization(origin, vapid, now));
    } catch {
      return null;
    }
  }
  return headers;
}

/**
 * vapidHeaders with the configured keys and clock (now when none is pinned);
 * null when no VAPID keys are configured.
 */
async function optionalVapidHeaders(
  devices: readonly PushDevice[],
  options: SendOptions,
): Promise<Map<string, string> | null> {
  if (options.vapid === undefined) {
    return null;
  }
  let now: Date;
  if (options.now !== undefined) {
    now = options.now;
  } else {
    now = new Date();
  }
  return await vapidHeaders(devices, options.vapid, now);
}

/**
 * Sends a run's notifications (one per spot; SQL's budget decides how many)
 * to every member device, with the destination's urgency and TTL. A
 * destination in quiet hours set to "Don't send" makes no request and reports
 * the whole batch sent, so the loop acks it. Otherwise the batch counts as
 * sent once any device took at least one notification: retrying would show
 * that device the same spots again. A device that is gone (404/410) is
 * reported for pruning, not as a failure; a 429 with no device reached delays
 * the batch.
 */
export async function sendPush(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
  options: SendOptions = {},
): Promise<SendResult> {
  if (pushSkipped(destination)) {
    return { ok: true, sent: deliveries.length };
  }
  const settings = pushSettingsOf(destination);
  let devices: PushDevice[] = [];
  if (destination.devices !== undefined && destination.devices !== null) {
    devices = destination.devices;
  }
  if (devices.length === 0) {
    return { ok: false, sent: 0, error: NO_DEVICES };
  }
  const headers = await optionalVapidHeaders(devices, options);
  if (headers === null) {
    return { ok: false, sent: 0, error: "Push isn't configured on the server." };
  }

  let quietNow = false;
  if (destination.quiet_now !== undefined && destination.quiet_now !== null) {
    quietNow = destination.quiet_now;
  }
  const notifications = pushNotifications(
    deliveries.map((d) => d.spot),
    settings,
    quietNow,
  );
  const payloads = notifications.map((n) => new TextEncoder().encode(pushPayload(n)));
  const topics = notifications.map((n) => pushTopic(n.tag));
  // A function declaration does not keep the null check's narrowing, so it reads a non-null copy.
  const originHeaders: Map<string, string> = headers;
  function authorization(endpoint: string): string | undefined {
    return originHeaders.get(new URL(endpoint).origin);
  }
  const outcomes = await Promise.all(
    devices.map((device) =>
      pushToDevice(device, payloads, topics, authorization, settings, options)
    ),
  );

  const expiredEndpoints: string[] = [];
  const deviceResults: PushDeviceResults = { ok: [], errors: {} };
  let reached = false;
  // Rate limited by any device: the longest Retry-After any of them gave, or
  // null when none gave one.
  let rateLimited = false;
  let retryAfter: number | null = null;
  let firstError: string | undefined;
  for (const entry of outcomes.entries()) {
    const index = entry[0];
    const outcome = entry[1];
    const device = devices[index];
    if (device === undefined) {
      throw new Error("sendPush: no device for a push outcome");
    }
    const endpoint = device.endpoint;
    if (outcome.accepted > 0) {
      reached = true;
    }
    if (outcome.kind === "accepted") {
      deviceResults.ok.push(endpoint);
    } else if (outcome.kind === "gone") {
      expiredEndpoints.push(endpoint);
    } else if (outcome.kind === "rate_limited") {
      deviceResults.errors[endpoint] = RATE_LIMITED;
      rateLimited = true;
      if (outcome.retryAfterSeconds !== null) {
        let longest = 0;
        if (retryAfter !== null) {
          longest = retryAfter;
        }
        retryAfter = Math.max(longest, outcome.retryAfterSeconds);
      }
    } else {
      deviceResults.errors[endpoint] = outcome.error;
      if (firstError === undefined) {
        firstError = outcome.error;
      }
    }
  }

  if (reached) {
    return { ok: true, sent: deliveries.length, expiredEndpoints, deviceResults };
  }
  if (rateLimited) {
    return {
      ok: false,
      sent: 0,
      error: RATE_LIMITED,
      retryAfterSeconds: retryAfter,
      expiredEndpoints,
      deviceResults,
    };
  }
  let error = NO_DEVICES;
  if (firstError !== undefined) {
    error = firstError;
  }
  return { ok: false, sent: 0, error, expiredEndpoints, deviceResults };
}
