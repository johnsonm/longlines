import { createServiceClient } from "../_shared/db.ts";
import { type DeleteAccountDeps, handleDeleteAccount } from "../_shared/handlers/delete_account.ts";

const deps: DeleteAccountDeps = { admin: createServiceClient };

async function handler(req: Request): Promise<Response> {
  return await handleDeleteAccount(req, deps);
}

Deno.serve(handler);
