// The streams the relay holds open. Each feed is one telnet connection whose
// lines are filtered against that feed's watchlist and pushed to one Edge
// Function. Adding a stream (DX Cluster, RBN FT8 on 7001) is a new entry here
// plus a source adapter in supabase/functions/_shared.

import { parseRbnLine } from "../supabase/functions/_shared/rbn.ts";

export interface Feed {
  /** Source id in raw_spots and ingest_state. */
  id: string;
  host: string;
  port: number;
  loginPrompt: RegExp;
  /** Edge Function that serves the watchlist (GET) and takes batches (POST). */
  functionName: string;
  /** The station a line reports, or null when the line is not a spot. */
  callsignOf(line: string): string | null;
}

export const RBN_FEED: Feed = {
  id: "rbn",
  host: "telnet.reversebeacon.net",
  // CW and RTTY skimmers. 7001 carries FT8/FT4 at a much higher rate.
  port: 7000,
  loginPrompt: /enter your call/i,
  functionName: "ingest-rbn",
  callsignOf: (line) => parseRbnLine(line)?.callsign ?? null,
};
