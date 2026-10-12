// The streams the relay holds open. Each feed is one telnet connection whose
// spot lines are all pushed to one Edge Function. Adding a stream (RBN FT8 on 7001, say) is a new
// entry here plus a source adapter in supabase/functions/_shared.

import { parseDxLine } from "../supabase/functions/_shared/dxcluster.ts";
import { parseRbnLine } from "../supabase/functions/_shared/rbn.ts";
import { portNumber } from "./config.ts";

export interface Feed {
  /** Source id in raw_spots and ingest_state. */
  id: string;
  host: string;
  port: number;
  loginPrompt: RegExp;
  /** Edge Function that takes batches (POST). */
  functionName: string;
  /** True for a spot line; banners, prompts and blank lines are not forwarded. */
  isSpot(line: string): boolean;
  /** Reconnect after this long without data (runTelnet's default, 5 minutes, when unset). */
  idleMs?: number;
  /** /healthz reports the feed unhealthy after this long without data (relay default when unset). */
  staleMs?: number;
}

export const RBN_FEED: Feed = {
  id: "rbn",
  host: "telnet.reversebeacon.net",
  // CW and RTTY skimmers. 7001 carries FT8/FT4 at a much higher rate.
  port: 7000,
  loginPrompt: /enter your call/i,
  functionName: "ingest-rbn",
  isSpot: (line) => parseRbnLine(line) !== null,
};

/** G1FEF-2, the DXSpider wiki maintainer's node: read access without registration. */
export const DXCLUSTER_DEFAULT_HOST = "dxc.hamserve.uk";
export const DXCLUSTER_DEFAULT_PORT = 7300;

/**
 * The DX Cluster feed. DXCLUSTER_HOST and DXCLUSTER_PORT pick another node.
 * Human spots can pause for several minutes overnight, so the idle reconnect
 * and the health threshold are longer than RBN's. Skimmer lines that a node
 * relays are not spots (parseDxLine), so they are never forwarded.
 */
export function dxclusterFeed(env: (name: string) => string | undefined): Feed {
  const port = env("DXCLUSTER_PORT")?.trim();
  return {
    id: "dxcluster",
    host: env("DXCLUSTER_HOST")?.trim() || DXCLUSTER_DEFAULT_HOST,
    port: port ? portNumber(port, "DXCLUSTER_PORT") : DXCLUSTER_DEFAULT_PORT,
    // DXSpider and AR-Cluster ask "login:"; CC Cluster asks for the call.
    loginPrompt: /login:|enter your call/i,
    functionName: "ingest-dxcluster",
    isSpot: (line) => parseDxLine(line) !== null,
    idleMs: 15 * 60_000,
    staleMs: 20 * 60_000,
  };
}
