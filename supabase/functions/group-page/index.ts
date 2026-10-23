import { createServiceClient } from "../_shared/db.ts";
import { handleGroupPage } from "../_shared/handlers/group_page.ts";
import { hmacKey } from "../_shared/hmac.ts";

// The service-role key doubles as the rate limit's HMAC key, as in
// callsign-profile, so both functions count against one per-client budget.
// The key is imported once per isolate, not per request.
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
let key: CryptoKey | undefined;
if (secret !== undefined && secret !== "") {
  key = await hmacKey(secret);
}

async function handler(req: Request): Promise<Response> {
  return await handleGroupPage(req, {
    db: createServiceClient,
    clientIpHeader: Deno.env.get("LONGLINES_CLIENT_IP_HEADER"),
    key,
  });
}

Deno.serve(handler);
