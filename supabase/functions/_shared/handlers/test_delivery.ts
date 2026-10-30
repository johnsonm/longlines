// "Send test": deliver one clearly labeled test spot to a destination the
// caller owns, using the same code path as real deliveries. A push
// destination's test goes to its member devices with the notification text
// built from its saved fields, and a Discord destination's message is rendered
// from its saved settings, for the sample spot or the spot the editor previews
// (spot_id). A webhook's body is rendered from its saved settings the same way,
// with its extra headers. SQL builds all of that (push_test_delivery,
// discord_test_delivery, webhook_test_delivery); this only sends it. A Local
// DX cluster gets a 400: only the sender's spots stream reaches a relay, and
// the relay's own "Send test spot" covers it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isUuid } from "../api/routes.ts";
import { userFromRequest } from "../auth.ts";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { LOCAL_CLUSTER_TEST, pushBookkeeping, type SendResult } from "../delivery/send.ts";
import {
  type DeliveryDestination,
  type DeliverySpot,
  deliverySpotSchema,
  type DiscordSettings,
  discordSettingsSchema,
  type PendingDelivery,
  type PushDevice,
  pushDeviceSchema,
  type PushSettings,
  pushSettingsSchema,
  type WebhookSettings,
  webhookSettingsSchema,
} from "../delivery/types.ts";
import { ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";
import { logError } from "../sentry.ts";

export interface SendTestDeps {
  admin: () => SupabaseClient;
  send: (
    destination: DeliveryDestination,
    deliveries: readonly PendingDelivery[],
  ) => Promise<SendResult>;
}

const PICK_DESTINATION = "Pick a destination.";

/** The web app's request (sendTest in web/src/lib/api.ts): a destination and, optionally, a spot. */
interface SendTestBody {
  destination_id: string;
  /** A raw_spots id to render instead of the sample; null or left out for the sample. */
  spot_id?: number | null;
}

// The web app's request body: strict. Any other JSON value, null included, is a missing
// destination, as is a key the web app never sends; z.number().int() takes safe integers only.
const sendTestBodySchema: z.ZodType<SendTestBody> = z.strictObject({
  destination_id: z.string({ error: PICK_DESTINATION }),
  spot_id: z.number({ error: "Pick a spot." }).int({ error: "Pick a spot." }).nullable().optional(),
}, { error: PICK_DESTINATION });

// record_send_test returns boolean: false over the limit, null for a destination the caller
// doesn't own.
const sendTestAllowedSchema: z.ZodType<boolean | null> = z.boolean().nullable();

export async function handleSendTest(
  req: Request,
  deps: SendTestDeps,
  now: Date,
): Promise<Response> {
  const preflight = preflightResponse(req, DEFAULT_METHODS);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, {});
  }

  const admin = deps.admin();
  const user = await userFromRequest(req, admin);
  if (user === null) {
    return json({ error: "Sign in again to send a test." }, 401, {});
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (error) {
    // A body that is not JSON names no destination. Anything else (a broken stream) is ours.
    if (error instanceof SyntaxError) {
      return json({ error: PICK_DESTINATION }, 400, {});
    }
    throw error;
  }
  // The first issue is the first key in order that is wrong, so a missing destination wins.
  const body = sendTestBodySchema.safeParse(raw);
  if (!body.success) {
    let message = PICK_DESTINATION;
    const issue = body.error.issues[0];
    if (issue !== undefined) {
      message = issue.message;
    }
    return json({ error: message }, 400, {});
  }
  const destinationId = body.data.destination_id;
  let spotId: number | null = null;
  if (body.data.spot_id !== undefined) {
    spotId = body.data.spot_id;
  }

  // The web path's limit (record_send_test: 10 a minute per destination, 30 per
  // account); the API's test is capped per token in api_call instead. A
  // destination the caller doesn't own answers null and sendTestTo says 404.
  if (isUuid(destinationId)) {
    const limit = await admin.rpc("record_send_test", {
      p_user_id: user.id,
      p_destination_id: destinationId,
    });
    if (limit.error !== null) {
      logError(`send-test: record_send_test failed: ${limit.error.message}`, limit.error);
      return json({ error: "Couldn't load that destination." }, 500, {});
    }
    let allowed: boolean | null;
    try {
      allowed = parseWith(
        sendTestAllowedSchema,
        limit.data,
        "handleSendTest: record_send_test result",
      );
    } catch (error) {
      return couldNotLoad(error);
    }
    if (allowed === false) {
      return json({ error: TOO_MANY_TESTS }, 429, {});
    }
  }

  return await sendTestTo(admin, user.id, destinationId, deps.send, now, spotId);
}

export const TOO_MANY_TESTS = "Too many tests. Wait a minute and try again.";
export const DESTINATION_THROTTLED =
  "This destination asked Long Lines to slow down. Try the test again in a few minutes.";

// The test RPCs build the destination's settings and the spot with the claim's own functions
// (push_spot_fields, discord_spot_fields, webhook_spot_fields, webhook_header_values, the
// settings tables), so they are read with the claim's schemas from delivery/types.ts.

/** What push_test_delivery returns: the destination's settings, its members and the rendered spot. */
interface PushTest {
  push: PushSettings;
  quiet_now: boolean;
  devices: PushDevice[];
  spot: DeliverySpot;
}

const pushTestSchema: z.ZodType<PushTest> = z.looseObject({
  push: pushSettingsSchema,
  quiet_now: z.boolean(),
  devices: z.array(pushDeviceSchema),
  spot: deliverySpotSchema,
});

/** What discord_test_delivery returns: the destination's settings and the rendered, test-marked spot. */
interface DiscordTest {
  discord: DiscordSettings;
  spot: DeliverySpot;
}

const discordTestSchema: z.ZodType<DiscordTest> = z.looseObject({
  discord: discordSettingsSchema,
  spot: deliverySpotSchema,
});

/** What webhook_test_delivery returns: the batch window, the header values and the rendered spot. */
interface WebhookTest {
  webhook: WebhookSettings;
  spot: DeliverySpot;
}

const webhookTestSchema: z.ZodType<WebhookTest> = z.looseObject({
  webhook: webhookSettingsSchema,
  spot: deliverySpotSchema,
});

// Each test RPC returns null for an unknown spot, or (no spot asked for) an unknown destination;
// each apply function below then returns null too.

// Its unblocked members, its settings and the spot rendered by SQL, as claim_deliveries would.
function applyPushTest(destination: DeliveryDestination, found: unknown): DeliverySpot | null {
  const test = parseWith(pushTestSchema.nullable(), found, "sendTestTo: push_test_delivery result");
  if (test === null) {
    return null;
  }
  destination.devices = test.devices;
  destination.push = test.push;
  destination.quiet_now = test.quiet_now;
  return test.spot;
}

// Its settings and the spot rendered by SQL with the test marker, as claim_deliveries would.
function applyDiscordTest(destination: DeliveryDestination, found: unknown): DeliverySpot | null {
  const test = parseWith(
    discordTestSchema.nullable(),
    found,
    "sendTestTo: discord_test_delivery result",
  );
  if (test === null) {
    return null;
  }
  destination.discord = test.discord;
  return test.spot;
}

// Its window, header values and the spot's pairs with connection "Test".
function applyWebhookTest(destination: DeliveryDestination, found: unknown): DeliverySpot | null {
  const test = parseWith(
    webhookTestSchema.nullable(),
    found,
    "sendTestTo: webhook_test_delivery result",
  );
  if (test === null) {
    return null;
  }
  destination.webhook = test.webhook;
  return test.spot;
}

/**
 * The SQL test RPC per destination type and how its result fills the destination: the spot, or
 * null when the RPC found none. Throws ValidationError on a result of the wrong shape.
 */
const TEST_RPCS: Record<
  Exclude<DeliveryDestination["type"], "local_cluster">,
  {
    rpc: string;
    apply: (destination: DeliveryDestination, found: unknown) => DeliverySpot | null;
  }
> = {
  push: { rpc: "push_test_delivery", apply: applyPushTest },
  discord: { rpc: "discord_test_delivery", apply: applyDiscordTest },
  webhook: { rpc: "webhook_test_delivery", apply: applyWebhookTest },
};

/** The destination columns sendTestTo loads. */
interface DestinationRow {
  id: string;
  type: DeliveryDestination["type"];
  name: string;
  url: string | null;
  signing_secret: string | null;
  health: DeliveryDestination["health"];
  consecutive_failures: number;
  throttled_until: string | null;
}

// A destinations row with the columns sendTestTo selects; loose, as any table row.
const destinationRowSchema: z.ZodType<DestinationRow> = z.looseObject({
  id: z.string(),
  type: z.enum(["discord", "webhook", "push", "local_cluster"]),
  name: z.string(),
  url: z.string().nullable(),
  signing_secret: z.string().nullable(),
  health: z.enum(["ok", "failing", "paused"]),
  consecutive_failures: z.number(),
  throttled_until: z.string().nullable(),
});

/** The 500 for a database result of the wrong shape; anything else is rethrown. */
function couldNotLoad(error: unknown): Response {
  if (!(error instanceof ValidationError)) {
    throw error;
  }
  logError(`send-test: ${error.message}`, error);
  return json({ error: "Couldn't load that destination." }, 500, {});
}

/** Null from a test RPC: the spot is unknown, or (with no spot asked for) the destination. */
function notFound(spotId: number | null): Response {
  // A missing settings row (which the triggers rule out) also reads as null; the
  // message then points at the destination, not a spot.
  if (spotId === null) {
    return json({ error: "Destination not found." }, 404, {});
  }
  return json({ error: "Spot not found." }, 404, {});
}

/**
 * Sends SQL's sample spot (or raw_spots row `spotId`), rendered with the destination's
 * settings, to one of the user's destinations. Shared with the management API's
 * POST /v1/destinations/{id}/test, which never passes a spot (the sample).
 */
export async function sendTestTo(
  admin: SupabaseClient,
  userId: string,
  destinationId: string,
  send: SendTestDeps["send"],
  now: Date,
  spotId: number | null,
): Promise<Response> {
  // Not a uuid cannot be a destination; PostgREST would answer 22P02.
  if (!isUuid(destinationId)) {
    return json({ error: "Destination not found." }, 404, {});
  }
  const loaded = await admin
    .from("destinations")
    .select("id, type, name, url, signing_secret, health, consecutive_failures, throttled_until")
    .eq("id", destinationId)
    .eq("user_id", userId)
    .maybeSingle();
  const data: unknown = loaded.data;
  const error = loaded.error;
  if (error !== null) {
    logError(`send-test: loading destination ${destinationId} failed: ${error.message}`, error);
    return json({ error: "Couldn't load that destination." }, 500, {});
  }
  if (data === null) {
    return json({ error: "Destination not found." }, 404, {});
  }

  let row: DestinationRow;
  try {
    row = parseWith(destinationRowSchema, data, "sendTestTo: destinations row");
  } catch (error) {
    return couldNotLoad(error);
  }

  // A destination the claim is holding back after a rate limit (throttle_destination)
  // gets no test either, on both paths.
  const throttledUntil = row.throttled_until;
  if (
    throttledUntil !== null && throttledUntil !== "" &&
    Date.parse(throttledUntil) > now.getTime()
  ) {
    return json({ error: DESTINATION_THROTTLED }, 429, {});
  }
  // Every column but throttled_until, in the order loaded.
  const destination: DeliveryDestination = {
    id: row.id,
    type: row.type,
    name: row.name,
    url: row.url,
    signing_secret: row.signing_secret,
    health: row.health,
    consecutive_failures: row.consecutive_failures,
  };
  // A relay's DX cluster is reached only through the sender's spots stream.
  if (destination.type === "local_cluster") {
    return json({ error: LOCAL_CLUSTER_TEST }, 400, {});
  }
  const testRpc = TEST_RPCS[destination.type];
  const rpc = testRpc.rpc;
  const test = await admin.rpc(rpc, { p_destination_id: destination.id, p_spot_id: spotId });
  if (test.error !== null) {
    logError(`send-test: ${rpc} failed: ${test.error.message}`, test.error);
    return json({ error: "Couldn't load that destination." }, 500, {});
  }
  let spot: DeliverySpot | null;
  try {
    spot = testRpc.apply(destination, test.data);
  } catch (error) {
    return couldNotLoad(error);
  }
  if (spot === null) {
    return notFound(spotId);
  }
  const delivery: PendingDelivery = {
    msg_id: 0,
    delivery_id: 0,
    subscription_id: "00000000-0000-0000-0000-000000000000",
    attempts: 0,
    created_at: now.toISOString(),
    destination,
    spot,
    test: true,
  };
  const result = await send(destination, [delivery]);
  for (const call of pushBookkeeping(result)) {
    const fn = call[0];
    const args = call[1];
    const bookkeeping = await admin.rpc(fn, args);
    const rpcError = bookkeeping.error;
    if (rpcError !== null) {
      logError(`send-test: ${fn} failed: ${rpcError.message}`, rpcError);
    }
  }

  // A webhook's answer carries the receiver's HTTP status when it got one.
  if (result.ok) {
    const sent: Record<string, unknown> = { ok: true };
    if (result.status !== undefined) {
      sent.status = result.status;
    }
    return json(sent, 200, {});
  }
  let message = "Delivery failed.";
  if (result.error !== undefined) {
    message = result.error;
  }
  const failed: Record<string, unknown> = { error: message };
  if (result.status !== undefined) {
    failed.status = result.status;
  }
  return json(failed, 502, {});
}
