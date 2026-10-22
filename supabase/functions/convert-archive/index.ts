import { archiveS3Config, createArchiveObjectStore } from "../_shared/archive_store.ts";
import { createServiceClient } from "../_shared/db.ts";
import { handleConvertArchive } from "../_shared/handlers/convert_archive.ts";

Deno.serve((req) =>
  handleConvertArchive(req, {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    db: createServiceClient,
    store: () => createArchiveObjectStore(archiveS3Config((name) => Deno.env.get(name))),
  })
);
