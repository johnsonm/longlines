import { createServiceClient } from "../_shared/db.ts";
import { type BandMapDeps, handleBandMap } from "../_shared/handlers/band_map.ts";

const deps: BandMapDeps = { db: createServiceClient };

async function handler(req: Request): Promise<Response> {
  return await handleBandMap(req, deps);
}

Deno.serve(handler);
