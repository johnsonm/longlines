// The streams the relay holds open. Each feed is one telnet (or plain TCP)
// connection whose spot lines are all pushed to one Edge Function. Adding a
// stream (RBN FT8 on 7001, say) is a new entry here plus a source adapter in
// supabase/functions/_shared.

import { parseAprsLine } from "../supabase/functions/_shared/aprs.ts";
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
  /** Telnet framing; false for a plain TCP line feed in UTF-8 (runTelnet's default, true, when unset). */
  telnet?: boolean;
  /** Login call for this feed instead of RELAY_LOGIN_CALL. */
  loginCall?: string;
  /** The line sent at the prompt, from the login call (the call itself when unset). */
  loginLine?: (call: string) => string;
  /** Lines the forwarder buffers during a Supabase outage (Forwarder's default when unset). */
  maxBuffer?: number;
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

/** Core and tier-2 APRS-IS servers in rotation; every one serves the full feed on 10152. */
export const APRS_DEFAULT_HOST = "rotate.aprs2.net";
export const APRS_DEFAULT_PORT = 10152;
/** Software name and version sent in the APRS-IS login line. */
export const APRS_SOFTWARE = "LongLines 0.1";

/**
 * The APRS-IS login call: CALL or CALL-SSID, letters and digits, at most nine
 * characters, uppercased. APRS-IS drops an older connection that logs in with
 * the same call-SSID, so it must not be one another client of the operator uses.
 */
export function aprsLoginCall(value: string): string {
  const call = value.trim().toUpperCase();
  if (call.length > 9 || !/^[A-Z0-9]{1,9}(-[A-Z0-9]{1,2})?$/.test(call)) {
    throw new Error("APRS_LOGIN_CALL must be a call or call-SSID of at most nine characters");
  }
  return call;
}

/**
 * The APRS-IS full feed: every packet on the network, no server-side filter.
 * Off (null) until APRS_LOGIN_CALL is set; APRS_HOST and APRS_PORT pick another
 * server. The login is receive-only (passcode -1). Servers send a "#" keepalive
 * about every 20 s, so a 2-minute silence means the connection is gone. The
 * buffer holds about 25 minutes of the feed at 100 packets/s.
 */
export function aprsFeed(env: (name: string) => string | undefined): Feed | null {
  const call = env("APRS_LOGIN_CALL")?.trim();
  if (!call) return null;
  const port = env("APRS_PORT")?.trim();
  return {
    id: "aprs",
    host: env("APRS_HOST")?.trim() || APRS_DEFAULT_HOST,
    port: port ? portNumber(port, "APRS_PORT") : APRS_DEFAULT_PORT,
    // The server's first line ("# aprsc 2.1.19-g730c5c0") is the cue to log in.
    loginPrompt: /^# /,
    functionName: "ingest-aprs",
    isSpot: (line) => parseAprsLine(line) !== null,
    telnet: false,
    loginCall: aprsLoginCall(call),
    loginLine: (c) => `user ${c} pass -1 vers ${APRS_SOFTWARE}`,
    idleMs: 2 * 60_000,
    staleMs: 5 * 60_000,
    maxBuffer: 150_000,
  };
}
