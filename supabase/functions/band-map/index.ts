import { createServiceClient } from "../_shared/db.ts";
import { handleBandMap } from "../_shared/handlers/band_map.ts";

Deno.serve((req) => handleBandMap(req, { db: createServiceClient }));
