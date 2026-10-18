// "Send test": deliver one clearly labeled sample spot to a destination the
// caller owns, using the same code path as real deliveries. A push
// destination's test goes to its member devices with the notification text
// built from its saved fields, for the sample spot or the spot the editor
// previews (spot_id). SQL builds all of that (push_test_delivery); this only
// sends it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "../api/routes.ts";
import { userFromRequest } from "../auth.ts";
import { json, preflightResponse } from "../cors.ts";
import { sampleSpot } from "../delivery/format.ts";
import { pushBookkeeping, type SendResult } from "../delivery/send.ts";
import type {
  DeliveryDestination,
  DeliverySpot,
  PendingDelivery,
  PushDevice,
  PushSettings,
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

  return await sendTestTo(admin, user.id, destinationId, deps.send, now, spotId as number | null);
}

/** What push_test_delivery returns: the destination's settings, its members and the rendered spot. */
interface PushTest {
  push: PushSettings;
  quiet_now: boolean;
  devices: PushDevice[];
  spot: DeliverySpot;
}

/**
 * Sends the sample spot (or, for push, raw_spots row `spotId`) to one of the
 * user's destinations. Shared with the management API's
 * POST /v1/destinations/{id}/test, which always sends the sample.
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
    .select("id, type, name, url, signing_secret, health, consecutive_failures")
    .eq("id", destinationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error(`send-test: loading destination ${destinationId} failed: ${error.message}`);
    return json({ error: "Couldn't load that destination." }, 500);
  }
  if (!data) return json({ error: "Destination not found." }, 404);

  const destination = data as DeliveryDestination;
  let spot = sampleSpot(destination);
  if (destination.type === "push") {
    // Its unblocked members, its settings and the spot rendered by SQL, as claim_deliveries would.
    const test = await admin.rpc("push_test_delivery", {
      p_destination_id: destination.id,
      p_spot_id: spotId,
    });
    if (test.error) {
      console.error(`send-test: push_test_delivery failed: ${test.error.message}`);
      return json({ error: "Couldn't load that destination." }, 500);
    }
    const found = test.data as PushTest | null;
    // Null means the spot is unknown, or the destination has no settings row (which the
    // trigger rules out; the message then points at the destination, not a spot).
    if (!found) {
      return json({ error: spotId === null ? "Destination not found." : "Spot not found." }, 404);
    }
    destination.devices = found.devices;
    destination.push = found.push;
    destination.quiet_now = found.quiet_now;
    spot = found.spot;
  }
  const delivery: PendingDelivery = {
    msg_id: 0,
    delivery_id: 0,
    subscription_id: "00000000-0000-0000-0000-000000000000",
    attempts: 0,
    created_at: now.toISOString(),
    destination,
    spot,
  };
  const result = await send(destination, [delivery]);
  for (const [fn, args] of pushBookkeeping(result)) {
    const { error: rpcError } = await admin.rpc(fn, args);
    if (rpcError) console.error(`send-test: ${fn} failed: ${rpcError.message}`);
  }

  return result.ok ? json({ ok: true }) : json({ error: result.error ?? "Delivery failed." }, 502);
}
