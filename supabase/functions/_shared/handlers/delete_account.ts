// Delete the calling user. Every user-owned row cascades from auth.users.

import type { SupabaseClient } from "@supabase/supabase-js";
import { userFromRequest } from "../auth.ts";
import { json, preflightResponse } from "../cors.ts";

export interface DeleteAccountDeps {
  admin: () => SupabaseClient;
}

export async function handleDeleteAccount(
  req: Request,
  deps: DeleteAccountDeps,
): Promise<Response> {
  const preflight = preflightResponse(req);
  if (preflight !== null) {
    return preflight;
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const admin = deps.admin();
  const user = await userFromRequest(req, admin);
  if (user === null) {
    return json({ error: "Sign in again to delete your account." }, 401);
  }

  const result = await admin.auth.admin.deleteUser(user.id);
  const error = result.error;
  if (error !== null) {
    console.error(`delete-account: ${error.message}`);
    return json({ error: "Couldn't delete your account. Try again." }, 500);
  }
  return json({ ok: true });
}
