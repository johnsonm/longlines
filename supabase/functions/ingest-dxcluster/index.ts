import { createIngestDb } from "../_shared/db.ts";
import { runDxclusterPush } from "../_shared/dxcluster.ts";
import { servePush } from "../_shared/serve.ts";

servePush("dxcluster", runDxclusterPush, createIngestDb);
