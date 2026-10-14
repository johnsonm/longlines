// HTTP delivery to Discord, webhooks and browser push services. Each function
// sends as much of the batch as it can, in order, and reports how many
// deliveries went out so the worker can mark exactly those as sent.

import { signWebhookBody } from "./hmac.ts";
import { discordMessages, pushNotifications, pushPayload, webhookPayloads } from "./format.ts";
import {
  assertSafeDestinationUrl,
  assertSafePushEndpoint,
  assertSafeResolvedHost,
  hostOf,
  type Resolver,
} from "./urlsafety.ts";
import { encryptPushPayload, vapidAuthorization, type VapidKeys } from "./webpush.ts";
import type { DeliveryDestination, PendingDelivery, PushDevice } from "./types.ts";

export const USER_AGENT = "LongLines/0.2";
export const DISCORD_MESSAGES_PER_RUN = 30; // Discord allows ~30 messages/minute per webhook
export const WEBHOOK_TIMEOUT_MS = 10_000;
const DISCORD_TIMEOUT_MS = 10_000;
const PUSH_TIMEOUT_MS = 10_000;
/** A push service drops a spot it couldn't deliver within 15 minutes. */
export const PUSH_TTL_SECONDS = 900;
const NO_DEVICES = "Turn on notifications on a device first.";
const NO_URL = "Destination has no URL";

export interface SendOptions {
  /** Tests only: skip URL safety so a loopback http server can stand in for the destination. */
  allowInsecure?: boolean;
  resolver?: Resolver;
  /** From LONGLINES_VAPID_* env; push sends fail without it. */
  vapid?: VapidKeys;
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
  /** Present when the rest should wait rather than count as a failure. */
  retryAfterSeconds?: number;
  /** Push only: subscriptions the push service says are gone (404/410), to prune. */
  expiredEndpoints?: string[];
  /** Push only. */
  deviceResults?: PushDeviceResults;
}

/**
 * The RPCs that follow a push send: prune subscriptions the push service says
 * are gone, then stamp each device's last success or error. Empty for the
 * other destination types. The deliver worker and Send test both run them.
 */
export function pushBookkeeping(result: SendResult): Array<[string, Record<string, unknown>]> {
  const calls: Array<[string, Record<string, unknown>]> = [];
  if (result.expiredEndpoints && result.expiredEndpoints.length > 0) {
    calls.push(["prune_push_devices", { p_endpoints: result.expiredEndpoints }]);
  }
  const devices = result.deviceResults;
  if (devices && (devices.ok.length > 0 || Object.keys(devices.errors).length > 0)) {
    calls.push(["record_push_results", { p_ok: devices.ok, p_errors: devices.errors }]);
  }
  return calls;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (destination.url === null) return { ok: false, sent: 0, error: NO_URL };
  if (!options.allowInsecure) {
    try {
      assertSafeDestinationUrl("discord", destination.url);
    } catch (error) {
      return { ok: false, sent: 0, error: errorMessage(error) };
    }
  }

  const messages = discordMessages(deliveries.map((d) => d.spot));
  const url = new URL(destination.url);
  url.searchParams.set("wait", "false");
  let sent = 0;

  for (const [index, message] of messages.entries()) {
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
      await response.body?.cancel();
      return {
        ok: false,
        sent,
        error: `Discord redirected (HTTP ${response.status}); redirects are not followed`,
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
    await response.body?.cancel();
    if (!response.ok) {
      return { ok: false, sent, error: `Discord HTTP ${response.status}` };
    }
    sent += message.embeds.length;
  }
  return { ok: true, sent };
}

/** Discord reports retry_after in seconds (fractional) in the body, or a Retry-After header. */
async function retryAfterSecondsOf(response: Response): Promise<number> {
  const header = Number(response.headers.get("retry-after"));
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // no JSON body
  }
  const fromBody = typeof body === "object" && body !== null
    ? Number((body as { retry_after?: unknown }).retry_after)
    : NaN;
  const seconds = Number.isFinite(fromBody) ? fromBody : Number.isFinite(header) ? header : 5;
  return Math.max(1, Math.ceil(seconds));
}

export async function sendWebhook(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
  options: SendOptions = {},
): Promise<SendResult> {
  if (destination.url === null) return { ok: false, sent: 0, error: NO_URL };
  if (!options.allowInsecure) {
    try {
      const url = assertSafeDestinationUrl("webhook", destination.url);
      await assertSafeResolvedHost(hostOf(url), options.resolver);
    } catch (error) {
      return { ok: false, sent: 0, error: errorMessage(error) };
    }
  }
  if (!destination.signing_secret) {
    return { ok: false, sent: 0, error: "Webhook destination has no signing secret" };
  }

  let sent = 0;
  for (const payload of webhookPayloads(deliveries)) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signWebhookBody(destination.signing_secret, timestamp, body);
    let response: Response;
    try {
      response = await fetch(destination.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "X-LongLines-Timestamp": String(timestamp),
          "X-LongLines-Signature": signature,
        },
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        redirect: "manual",
      });
    } catch (error) {
      return { ok: false, sent, error: `Webhook request failed: ${errorMessage(error)}` };
    }
    await response.body?.cancel();
    if (isRedirect(response)) {
      return {
        ok: false,
        sent,
        error: `Webhook redirected (HTTP ${response.status}); redirects are not followed`,
      };
    }
    if (!response.ok) {
      return { ok: false, sent, error: `Webhook HTTP ${response.status}` };
    }
    sent += payload.deliveries.length;
  }
  return { ok: true, sent };
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

type DeviceOutcome =
  | { kind: "accepted" }
  | { kind: "gone" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "error"; error: string };

/** Push's Topic header allows at most 32 characters of the URL-safe base64 alphabet. */
export function pushTopic(tag: string): string {
  return tag.replace(/:/g, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
}

function pushRetryAfterSeconds(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
}

/** Sends every notification to one device, in order, stopping at its first refusal. */
async function pushToDevice(
  device: PushDevice,
  payloads: readonly Uint8Array[],
  topics: readonly string[],
  vapid: VapidKeys,
  options: SendOptions,
): Promise<DeviceOutcome> {
  try {
    if (!options.allowInsecure) assertSafePushEndpoint(device.endpoint);
    const authorization = await vapidAuthorization(device.endpoint, vapid, new Date());
    for (const [index, payload] of payloads.entries()) {
      const body = await encryptPushPayload(payload, device);
      let response: Response;
      try {
        response = await fetch(device.endpoint, {
          method: "POST",
          headers: {
            "Authorization": authorization,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": String(PUSH_TTL_SECONDS),
            "Urgency": "high",
            "Topic": topics[index] ?? "",
            "User-Agent": USER_AGENT,
          },
          body,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          redirect: "manual",
        });
      } catch (error) {
        return { kind: "error", error: `Push request failed: ${errorMessage(error)}` };
      }
      await response.body?.cancel();
      if (isRedirect(response)) {
        return {
          kind: "error",
          error: `Push redirected (HTTP ${response.status}); redirects are not followed`,
        };
      }
      if (response.status === 404 || response.status === 410) return { kind: "gone" };
      if (response.status === 429) {
        return { kind: "rate_limited", retryAfterSeconds: pushRetryAfterSeconds(response) };
      }
      if (response.status !== 201 && response.status !== 202) {
        return { kind: "error", error: `Push HTTP ${response.status}` };
      }
    }
    return { kind: "accepted" };
  } catch (error) {
    return { kind: "error", error: errorMessage(error) };
  }
}

/**
 * Sends a run's notifications (three spots, then a summary) to every device.
 * The batch counts as sent when at least one device accepted everything; a
 * device that is gone (404/410) is reported for pruning, not as a failure.
 */
export async function sendPush(
  destination: DeliveryDestination,
  deliveries: readonly PendingDelivery[],
  options: SendOptions = {},
): Promise<SendResult> {
  const devices = destination.devices ?? [];
  if (devices.length === 0) return { ok: false, sent: 0, error: NO_DEVICES };
  if (!options.vapid) return { ok: false, sent: 0, error: "Push isn't configured on the server." };
  const vapid = options.vapid;

  const notifications = pushNotifications(deliveries.map((d) => d.spot));
  const payloads = notifications.map((n) => new TextEncoder().encode(pushPayload(n)));
  const topics = notifications.map((n) => pushTopic(n.tag));
  const outcomes = await Promise.all(
    devices.map((device) => pushToDevice(device, payloads, topics, vapid, options)),
  );

  const expiredEndpoints: string[] = [];
  const deviceResults: PushDeviceResults = { ok: [], errors: {} };
  let retryAfterSeconds: number | undefined;
  let firstError: string | undefined;
  for (const [index, outcome] of outcomes.entries()) {
    const endpoint = devices[index]!.endpoint;
    if (outcome.kind === "accepted") deviceResults.ok.push(endpoint);
    else if (outcome.kind === "gone") expiredEndpoints.push(endpoint);
    else if (outcome.kind === "rate_limited") {
      retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, outcome.retryAfterSeconds);
    } else {
      deviceResults.errors[endpoint] = outcome.error;
      firstError ??= outcome.error;
    }
  }

  const reported = { expiredEndpoints, deviceResults };
  if (deviceResults.ok.length > 0) return { ok: true, sent: deliveries.length, ...reported };
  if (retryAfterSeconds !== undefined) {
    return {
      ok: false,
      sent: 0,
      error: "Push HTTP 429 (rate limited)",
      retryAfterSeconds,
      ...reported,
    };
  }
  return { ok: false, sent: 0, error: firstError ?? NO_DEVICES, ...reported };
}
