import { createIsedSpecialDb, createServiceClient } from "../_shared/db.ts";
import { handleLoadIsedSpecial } from "../_shared/handlers/load_ised_special.ts";
import type { IsedSpecialDb } from "../_shared/types.ts";

function isedSpecialDb(): IsedSpecialDb {
  return createIsedSpecialDb(createServiceClient());
}

async function handler(req: Request): Promise<Response> {
  return await handleLoadIsedSpecial(req, {
    secret: Deno.env.get("LONGLINES_INBOUND_SECRET"),
    db: isedSpecialDb,
  });
}

Deno.serve(handler);
