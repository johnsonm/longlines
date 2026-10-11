// The relay's call to its Edge Function: push a batch of lines.

import { userAgent } from "../supabase/functions/_shared/http.ts";

export interface RelayLine {
  line: string;
  /** ISO 8601 UTC; the adapter dates the spot's HHMMZ stamp from this. */
  received_at: string;
}

export interface FunctionClient {
  push(lines: RelayLine[]): Promise<unknown>;
}

const TIMEOUT_MS = 15_000;

export function functionClient(
  functionsUrl: string,
  functionName: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): FunctionClient {
  const url = `${functionsUrl}/${functionName}`;
  const headers = { "User-Agent": userAgent(), "x-relay-secret": secret };

  async function call(init: RequestInit): Promise<unknown> {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method} ${functionName}: HTTP ${res.status} ${text}`);
    return JSON.parse(text);
  }

  return {
    push(lines: RelayLine[]): Promise<unknown> {
      return call({
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
    },
  };
}
