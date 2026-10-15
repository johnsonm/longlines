import { archiveS3Config, createArchiveStore } from "../_shared/archive_store.ts";
import { createServiceClient } from "../_shared/db.ts";
import { handleArchive } from "../_shared/handlers/archive.ts";

Deno.serve((req) =>
  handleArchive(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
    store: () => createArchiveStore(archiveS3Config((name) => Deno.env.get(name))),
  })
);
