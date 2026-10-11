// The streams the relay holds open. Each feed is one telnet connection whose
// spot lines are all pushed to one Edge Function. Adding a stream (DX Cluster, RBN FT8 on 7001) is a new entry here
// plus a source adapter in supabase/functions/_shared.

import { parseRbnLine } from "../supabase/functions/_shared/rbn.ts";

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
