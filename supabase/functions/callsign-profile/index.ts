import { createServiceClient } from "../_shared/db.ts";
import { handleProfile } from "../_shared/handlers/callsign_profile.ts";
import { hmacKey } from "../_shared/hmac.ts";

// The service-role key doubles as the rate limit's HMAC key: every deployment
// has it and it never leaves the server. Rotating it only resets the current
// minute. The key is imported once per isolate, not per request.
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const key = secret ? await hmacKey(secret) : undefined;

Deno.serve((req) =>
  handleProfile(req, {
    db: createServiceClient,
    clientIpHeader: Deno.env.get("LONGLINES_CLIENT_IP_HEADER"),
    key,
  })
);
