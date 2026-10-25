import { archiveS3Config, createArchiveStore } from "../_shared/archive_store.ts";
import { createServiceClient } from "../_shared/db.ts";
import { handleArchive } from "../_shared/handlers/archive.ts";
import type { ArchiveStore } from "../_shared/types.ts";

function store(): ArchiveStore {
  return createArchiveStore(archiveS3Config((name) => Deno.env.get(name)));
}

async function handler(req: Request): Promise<Response> {
  return await handleArchive(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
    store,
  }, new Date());
}

Deno.serve(handler);
