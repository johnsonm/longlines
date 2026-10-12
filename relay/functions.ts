// The relay's calls to its Edge Functions: push a batch of lines, or POST any
// JSON body (the license load).

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

/** POST `body` as JSON with the relay secret; the parsed reply, or an error for non-2xx. */
export function functionPoster(
  functionsUrl: string,
  functionName: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): (body: unknown) => Promise<unknown> {
  const url = `${functionsUrl}/${functionName}`;
  return async (body: unknown): Promise<unknown> => {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "User-Agent": userAgent(),
        "x-relay-secret": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${functionName}: HTTP ${res.status} ${text}`);
    return JSON.parse(text);
  };
}

export function functionClient(
  functionsUrl: string,
  functionName: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): FunctionClient {
  const post = functionPoster(functionsUrl, functionName, secret, fetchFn);
  return { push: (lines: RelayLine[]) => post({ lines }) };
}
