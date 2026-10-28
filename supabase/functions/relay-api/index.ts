import { createServiceClient } from "../_shared/db.ts";
import { handleRelayApi } from "../_shared/handlers/relay_api.ts";
import { hmacKey } from "../_shared/hmac.ts";

// The service-role key doubles as the per-client limit's HMAC key, as in callsign-profile, so
// both key one client the same way. The key is imported once per isolate, not per request.
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
let key: CryptoKey | undefined;
if (secret !== undefined && secret !== "") {
  key = await hmacKey(secret);
}

async function handler(req: Request): Promise<Response> {
  return await handleRelayApi(req, {
    db: createServiceClient,
    clientIpHeader: Deno.env.get("LONGLINES_CLIENT_IP_HEADER"),
    key,
  }, new Date());
}

Deno.serve(handler);
