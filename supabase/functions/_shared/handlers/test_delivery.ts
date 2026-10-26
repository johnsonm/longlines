// "Send test": deliver one clearly labeled test spot to a destination the
// caller owns, using the same code path as real deliveries. A push
// destination's test goes to its member devices with the notification text
// built from its saved fields, and a Discord destination's message is rendered
// from its saved settings, for the sample spot or the spot the editor previews
// (spot_id). A webhook's body is rendered from its saved settings the same way,
// with its extra headers. SQL builds all of that (push_test_delivery,
// discord_test_delivery, webhook_test_delivery); this only sends it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isUuid } from "../api/routes.ts";
import { userFromRequest } from "../auth.ts";
import { DEFAULT_METHODS, json, preflightResponse } from "../cors.ts";
import { pushBookkeeping, type SendResult } from "../delivery/send.ts";
import type {
  DeliveryDestination,
  DeliverySpot,
  DiscordSettings,
  PendingDelivery,
  PushDevice,
  PushSettings,
  WebhookField,
  WebhookHeader,
  WebhookSettings,
} from "../delivery/types.ts";
import { ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";

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
      console.error(`send-test: record_send_test failed: ${limit.error.message}`);
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

// The shapes below are derived from the SQL that builds them: delivery_spot_json and
// push_sample_spot, the push/discord/webhook spot_fields renderers, the settings tables and
// destinations (migrations 20261016000400, 20261018000100, 20261018000300, 20261021000300). Every
// key is always present; null only where the delivery types allow it. RPC jsonb can gain keys
// across deploys, so every object is loose.

const nullableText = z.string().nullable();

const discordGridItemSchema = z.looseObject({ name: z.string(), value: z.string() });

const webhookFieldSchema: z.ZodType<WebhookField> = z.looseObject({
  key: z.string(),
  value: z.union([z.string(), z.number()]).nullable(),
});

// A spot as the test RPCs render it: the raw_spots row (or the sample) plus the keys its
// destination type's renderer adds, which are absent for the other types.
const deliverySpotSchema: z.ZodType<DeliverySpot> = z.looseObject({
  id: z.number(),
  source: z.string(),
  spot_time: z.string(),
  callsign: z.string(),
  base_callsign: nullableText,
  spotter: nullableText,
  frequency_khz: z.number(),
  band: nullableText,
  mode: nullableText,
  mode_family: nullableText,
  comment: z.string(),
  pota_reference: nullableText,
  pota_park_name: nullableText,
  pota_location: nullableText,
  sota_summit_ref: nullableText,
  wwff_reference: nullableText,
  wwff_reference_name: nullableText,
  push_title: z.string().optional(),
  push_body: z.string().optional(),
  push_url: z.string().optional(),
  push_source_url: nullableText.optional(),
  discord_style: z.enum(["card", "plain"]).optional(),
  discord_title: z.string().optional(),
  discord_description: z.string().optional(),
  discord_grid: z.array(discordGridItemSchema).optional(),
  discord_footer: nullableText.optional(),
  discord_color: z.number().optional(),
  discord_url: nullableText.optional(),
  discord_line: z.string().optional(),
  discord_suppress_embeds: z.boolean().optional(),
  webhook_fields: z.array(webhookFieldSchema).optional(),
  webhook_connection: z.string().optional(),
});

const separatorSchema = z.enum(["dot", "comma", "newline"]);

// push_destination_settings, less destination_id.
const pushSettingsSchema: z.ZodType<PushSettings> = z.looseObject({
  title_fields: z.array(z.string()),
  body_fields: z.array(z.string()),
  show_field_names: z.boolean(),
  body_separator: separatorSchema,
  tap_target: z.enum(["profile", "source"]),
  action_buttons: z.boolean(),
  urgency: z.enum(["low", "normal", "high"]),
  ttl_seconds: z.number(),
  replace_same_station: z.boolean(),
  sound: z.boolean(),
  quiet_enabled: z.boolean(),
  quiet_from: z.string(),
  quiet_until: z.string(),
  quiet_mode: z.enum(["silent", "skip"]),
});

// push_member_devices: the destination's unblocked member devices.
const pushDeviceSchema: z.ZodType<PushDevice> = z.looseObject({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
});

// discord_destination_settings, less destination_id.
const discordSettingsSchema: z.ZodType<DiscordSettings> = z.looseObject({
  style: z.enum(["card", "plain"]),
  title_fields: z.array(z.string()),
  detail_fields: z.array(z.string()),
  grid_fields: z.array(z.string()),
  title_link: z.enum(["profile", "source", "none"]),
  card_color: z.enum(["source", "blue", "green", "purple", "orange", "red", "grey"]),
  footer: z.boolean(),
  line_fields: z.array(z.string()),
  bold_first: z.boolean(),
  link_preview: z.enum(["hidden", "shown"]),
  show_field_names: z.boolean(),
  separator: separatorSchema,
  batch_seconds: z.number(),
});

// webhook_header_values: the extra headers, in position order, their values from Vault.
const webhookHeaderSchema: z.ZodType<WebhookHeader> = z.looseObject({
  name: z.string(),
  value: z.string(),
});

const webhookSettingsSchema: z.ZodType<WebhookSettings> = z.looseObject({
  batch_seconds: z.number(),
  headers: z.array(webhookHeaderSchema),
});

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
  DeliveryDestination["type"],
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
  type: z.enum(["discord", "webhook", "push"]),
  name: z.string(),
  url: nullableText,
  signing_secret: nullableText,
  health: z.enum(["ok", "failing", "paused"]),
  consecutive_failures: z.number(),
  throttled_until: nullableText,
});

/** The 500 for a database result of the wrong shape; anything else is rethrown. */
function couldNotLoad(error: unknown): Response {
  if (!(error instanceof ValidationError)) {
    throw error;
  }
  console.error(`send-test: ${error.message}`);
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
  const data = loaded.data;
  const error = loaded.error;
  if (error !== null) {
    console.error(`send-test: loading destination ${destinationId} failed: ${error.message}`);
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
  const testRpc = TEST_RPCS[destination.type];
  const rpc = testRpc.rpc;
  const test = await admin.rpc(rpc, { p_destination_id: destination.id, p_spot_id: spotId });
  if (test.error !== null) {
    console.error(`send-test: ${rpc} failed: ${test.error.message}`);
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
      console.error(`send-test: ${fn} failed: ${rpcError.message}`);
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
