// "Send test": deliver one clearly labeled sample spot to a destination the
// caller owns, using the same code path as real deliveries.

import type { SupabaseClient } from "@supabase/supabase-js";
import { userFromRequest } from "../auth.ts";
import { json, preflightResponse } from "../cors.ts";
import { sampleSpot } from "../delivery/format.ts";
import type { SendResult } from "../delivery/send.ts";
import type { DeliveryDestination, PendingDelivery } from "../delivery/types.ts";

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

  let destinationId: unknown;
  try {
    destinationId = ((await req.json()) as { destination_id?: unknown }).destination_id;
  } catch {
    destinationId = undefined;
  }
  if (typeof destinationId !== "string") return json({ error: "Pick a destination." }, 400);

  return await sendTestTo(admin, user.id, destinationId, deps.send, now);
}

/**
 * Sends the sample spot to one of the user's destinations. Shared with the
 * management API's POST /v1/destinations/{id}/test.
 */
export async function sendTestTo(
  admin: SupabaseClient,
  userId: string,
  destinationId: string,
  send: SendTestDeps["send"],
  now: Date,
): Promise<Response> {
  const { data, error } = await admin
    .from("destinations")
    .select("id, type, name, url, signing_secret, health, consecutive_failures")
    .eq("id", destinationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return json({ error: "Couldn't load that destination." }, 500);
  if (!data) return json({ error: "Destination not found." }, 404);

  const destination = data as DeliveryDestination;
  const delivery: PendingDelivery = {
    msg_id: 0,
    delivery_id: 0,
    subscription_id: "00000000-0000-0000-0000-000000000000",
    attempts: 0,
    created_at: now.toISOString(),
    destination,
    spot: sampleSpot(destination),
  };
  const result = await send(destination, [delivery]);

  return result.ok ? json({ ok: true }) : json({ error: result.error ?? "Delivery failed." }, 502);
}
