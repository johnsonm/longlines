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
  push(lines: RelayLine[], signal: AbortSignal | undefined): Promise<unknown>;
}

const TIMEOUT_MS = 15_000;

export interface FunctionPosterConfig {
  functionsUrl: string;
  functionName: string;
  secret: string;
  fetchFn: typeof fetch;
}

/**
 * POSTs JSON bodies to one Edge Function with the relay secret: the parsed reply, or an error
 * for non-2xx. Each request aborts after TIMEOUT_MS, or sooner when `signal` aborts.
 */
export class FunctionPoster {
  private readonly url: string;
  private readonly functionName: string;
  private readonly secret: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: FunctionPosterConfig) {
    this.url = `${config.functionsUrl}/${config.functionName}`;
    this.functionName = config.functionName;
    this.secret = config.secret;
    this.fetchFn = config.fetchFn;
  }

  async post(body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let requestSignal = timeout;
    if (signal !== undefined) {
      requestSignal = AbortSignal.any([timeout, signal]);
    }
    // Called unbound, as before: fetch never sees the poster as `this`.
    const fetchFn = this.fetchFn;
    const res = await fetchFn(this.url, {
      method: "POST",
      headers: {
        "User-Agent": userAgent(),
        "x-relay-secret": this.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`POST ${this.functionName}: HTTP ${String(res.status)} ${text}`);
    }
    return JSON.parse(text);
  }
}

export function functionClient(config: FunctionPosterConfig): FunctionClient {
  const poster = new FunctionPoster(config);
  return {
    push: (lines: RelayLine[], signal: AbortSignal | undefined) => poster.post({ lines }, signal),
  };
}
