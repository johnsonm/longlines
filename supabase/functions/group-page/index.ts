import { createServiceClient } from "../_shared/db.ts";
import { handleGroupPage } from "../_shared/handlers/group_page.ts";
import { hmacKey } from "../_shared/hmac.ts";

// The service-role key doubles as the rate limit's HMAC key, as in
// callsign-profile, so both functions count against one per-client budget.
// The key is imported once per isolate, not per request.
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const key = secret ? await hmacKey(secret) : undefined;

Deno.serve((req) =>
  handleGroupPage(req, {
    db: createServiceClient,
    clientIpHeader: Deno.env.get("LONGLINES_CLIENT_IP_HEADER"),
    key,
  })
);
