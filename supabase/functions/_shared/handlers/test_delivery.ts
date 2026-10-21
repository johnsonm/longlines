// "Send test": deliver one clearly labeled test spot to a destination the
// caller owns, using the same code path as real deliveries. A push
// destination's test goes to its member devices with the notification text
// built from its saved fields, and a Discord destination's message is rendered
// from its saved settings, for the sample spot or the spot the editor previews
// (spot_id). A webhook's body is rendered from its saved settings the same way,
// with its extra headers. SQL builds all of that (push_test_delivery,
// discord_test_delivery, webhook_test_delivery); this only sends it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "../api/routes.ts";
import { userFromRequest } from "../auth.ts";
import { json, preflightResponse } from "../cors.ts";
import { pushBookkeeping, type SendResult } from "../delivery/send.ts";
import type {
  DeliveryDestination,
  DeliverySpot,
  DiscordSettings,
  PendingDelivery,
  PushDevice,
  PushSettings,
  WebhookSettings,
} from "../delivery/types.ts";

export interface SendTestDeps {
  admin: () => SupabaseClient;
  send: (
    destination: DeliveryDestination,
    deliveries: readonly PendingDelivery[],
  ) => Promise<SendResult>;
}

export async function handleSendTest(
  req: Request,
  deps: SendTestDeps,
  now: Date = new Date(),
): Promise<Response> {
  const preflight = preflightResponse(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const admin = deps.admin();
  const user = await userFromRequest(req, admin);
  if (!user) return json({ error: "Sign in again to send a test." }, 401);

  let body: { destination_id?: unknown; spot_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const destinationId = body?.destination_id;
  if (typeof destinationId !== "string") return json({ error: "Pick a destination." }, 400);
  const spotId = body?.spot_id ?? null;
  if (spotId !== null && !Number.isSafeInteger(spotId)) {
    return json({ error: "Pick a spot." }, 400);
  }

  // The web path's limit (record_send_test: 10 a minute per destination, 30 per
  // account); the API's test is capped per token in api_call instead. A
  // destination the caller doesn't own answers null and sendTestTo says 404.
  if (isUuid(destinationId)) {
    const limit = await admin.rpc("record_send_test", {
      p_user_id: user.id,
      p_destination_id: destinationId,
    });
    if (limit.error) {
      console.error(`send-test: record_send_test failed: ${limit.error.message}`);
      return json({ error: "Couldn't load that destination." }, 500);
    }
    if (limit.data === false) return json({ error: TOO_MANY_TESTS }, 429);
  }

  return await sendTestTo(admin, user.id, destinationId, deps.send, now, spotId as number | null);
}

export const TOO_MANY_TESTS = "Too many tests. Wait a minute and try again.";
export const DESTINATION_THROTTLED =
  "This destination asked Long Lines to slow down. Try the test again in a few minutes.";

/** What push_test_delivery returns: the destination's settings, its members and the rendered spot. */
interface PushTest {
  push: PushSettings;
  quiet_now: boolean;
  devices: PushDevice[];
  spot: DeliverySpot;
}

/** What discord_test_delivery returns: the destination's settings and the rendered, test-marked spot. */
interface DiscordTest {
  discord: DiscordSettings;
  spot: DeliverySpot;
}

/** What webhook_test_delivery returns: the batch window, the header values and the rendered spot. */
interface WebhookTest {
  webhook: WebhookSettings;
  spot: DeliverySpot;
}

/** The SQL test RPC per destination type and how its result fills the destination. */
const TEST_RPCS: Record<
  DeliveryDestination["type"],
  { rpc: string; apply: (destination: DeliveryDestination, found: unknown) => DeliverySpot }
> = {
  // Its unblocked members, its settings and the spot rendered by SQL, as claim_deliveries would.
  push: {
    rpc: "push_test_delivery",
    apply: (destination, found) => {
      const test = found as PushTest;
      destination.devices = test.devices;
      destination.push = test.push;
      destination.quiet_now = test.quiet_now;
      return test.spot;
    },
  },
  // Its settings and the spot rendered by SQL with the test marker, as claim_deliveries would.
  discord: {
    rpc: "discord_test_delivery",
    apply: (destination, found) => {
      const test = found as DiscordTest;
      destination.discord = test.discord;
      return test.spot;
    },
  },
  // Its window, header values and the spot's pairs with connection "Test".
  webhook: {
    rpc: "webhook_test_delivery",
    apply: (destination, found) => {
      const test = found as WebhookTest;
      destination.webhook = test.webhook;
      return test.spot;
    },
  },
};

/** Null from a test RPC: the spot is unknown, or (with no spot asked for) the destination. */
function notFound(spotId: number | null): Response {
  // A missing settings row (which the triggers rule out) also reads as null; the
  // message then points at the destination, not a spot.
  return json({ error: spotId === null ? "Destination not found." : "Spot not found." }, 404);
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
  spotId: number | null = null,
): Promise<Response> {
  // Not a uuid cannot be a destination; PostgREST would answer 22P02.
  if (!isUuid(destinationId)) return json({ error: "Destination not found." }, 404);
  const { data, error } = await admin
    .from("destinations")
    .select("id, type, name, url, signing_secret, health, consecutive_failures, throttled_until")
    .eq("id", destinationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error(`send-test: loading destination ${destinationId} failed: ${error.message}`);
    return json({ error: "Couldn't load that destination." }, 500);
  }
  if (!data) return json({ error: "Destination not found." }, 404);

  // A destination the claim is holding back after a rate limit (throttle_destination)
  // gets no test either, on both paths.
  const { throttled_until: throttledUntil, ...row } = data as DeliveryDestination & {
    throttled_until?: string | null;
  };
  if (throttledUntil && Date.parse(throttledUntil) > now.getTime()) {
    return json({ error: DESTINATION_THROTTLED }, 429);
  }
  const destination = row as DeliveryDestination;
  const { rpc, apply } = TEST_RPCS[destination.type];
  const test = await admin.rpc(rpc, { p_destination_id: destination.id, p_spot_id: spotId });
  if (test.error) {
    console.error(`send-test: ${rpc} failed: ${test.error.message}`);
    return json({ error: "Couldn't load that destination." }, 500);
  }
  if (!test.data) return notFound(spotId);
  const spot = apply(destination, test.data);
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
  for (const [fn, args] of pushBookkeeping(result)) {
    const { error: rpcError } = await admin.rpc(fn, args);
    if (rpcError) console.error(`send-test: ${fn} failed: ${rpcError.message}`);
  }

  // A webhook's answer carries the receiver's HTTP status when it got one.
  const status = result.status === undefined ? {} : { status: result.status };
  return result.ok
    ? json({ ok: true, ...status })
    : json({ error: result.error ?? "Delivery failed.", ...status }, 502);
}
