import { createClient } from "@supabase/supabase-js";
import { createServiceClient } from "../_shared/db.ts";
import { handleSignIn } from "../_shared/handlers/sign_in.ts";
import { hmacKey } from "../_shared/hmac.ts";

// The service-role key doubles as the attempt log's HMAC key, as in
// callsign-profile. Imported once per isolate, not per request.
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const key = secret ? await hmacKey(secret) : undefined;

Deno.serve((req) =>
  handleSignIn(req, {
    admin: createServiceClient,
    anon: () =>
      createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    clientIpHeader: Deno.env.get("LONGLINES_CLIENT_IP_HEADER"),
    key,
  })
);
