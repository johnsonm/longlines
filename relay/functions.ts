// The relay's calls to its Edge Functions: push a batch of lines, or POST any
// JSON body (the license load).

import { userAgent } from "../supabase/functions/_shared/http.ts";

export interface RelayLine {
  line: string;
  /** ISO 8601 UTC; the adapter dates the spot's HHMMZ stamp from this. */
  received_at: string;
}

export interface FunctionClient {
  /** `signal` aborts the request early (shutdown's drain deadline). */
  push(lines: RelayLine[], signal?: AbortSignal): Promise<unknown>;
}

const TIMEOUT_MS = 15_000;

/**
 * POST `body` as JSON with the relay secret; the parsed reply, or an error for non-2xx.
 * The request aborts after TIMEOUT_MS, or sooner when `signal` aborts.
 */
export function functionPoster(
  functionsUrl: string,
  functionName: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): (body: unknown, signal?: AbortSignal) => Promise<unknown> {
  const url = `${functionsUrl}/${functionName}`;
  return async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "User-Agent": userAgent(),
        "x-relay-secret": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
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
  return { push: (lines: RelayLine[], signal?: AbortSignal) => post({ lines }, signal) };
}
