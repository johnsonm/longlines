import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../_shared/db.ts";
import { handleSignIn, type SignInDeps } from "../_shared/handlers/sign_in.ts";
import { hmacKey } from "../_shared/hmac.ts";

// The service-role key doubles as the attempt log's HMAC key, as in
// callsign-profile. Imported once per isolate, not per request.
const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
let key: CryptoKey | undefined = undefined;
if (secret !== undefined && secret !== "") {
  key = await hmacKey(secret);
}

/** An env variable, or "" when it is unset. */
function envOrEmpty(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined) {
    return "";
  }
  return value;
}

// Built per request, reading the URL and the anon key each time.
function anon(): SupabaseClient {
  return createClient(
    envOrEmpty("SUPABASE_URL"),
    envOrEmpty("SUPABASE_ANON_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

async function handler(req: Request): Promise<Response> {
  const deps: SignInDeps = {
    admin: createServiceClient,
    anon,
    clientIpHeader: Deno.env.get("LONGLINES_CLIENT_IP_HEADER"),
    key,
  };
  return await handleSignIn(req, deps);
}

Deno.serve(handler);
