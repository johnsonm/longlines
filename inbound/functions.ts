// The inbound worker's calls to its Edge Functions: push a batch of lines, or POST any
// JSON body (the license load).

import { FunctionCallError, ValidationError } from "../supabase/functions/_shared/errors.ts";
import { userAgent } from "../supabase/functions/_shared/http.ts";

export interface InboundLine {
  line: string;
  /** ISO 8601 UTC; the adapter dates the spot's HHMMZ stamp from this. */
  received_at: string;
}

export interface FunctionClient {
  /** `signal` aborts the request early (shutdown's drain deadline). */
  push(lines: InboundLine[], signal: AbortSignal | undefined): Promise<unknown>;
}

const TIMEOUT_MS = 15_000;

export interface FunctionPosterConfig {
  functionsUrl: string;
  functionName: string;
  secret: string;
  fetchFn: typeof fetch;
}

/**
 * POSTs JSON bodies to one Edge Function with the inbound secret: the parsed reply, a
 * FunctionCallError for non-2xx, or a ValidationError for a reply that is not JSON. Each request
 * aborts after TIMEOUT_MS, or sooner when `signal` aborts. Callers validate the reply they read.
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
        "x-inbound-secret": this.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new FunctionCallError(`POST ${this.functionName}: HTTP ${String(res.status)} ${text}`, {
        cause: undefined,
        status: res.status,
      });
    }
    return parseReply(text, this.functionName);
  }
}

/**
 * The reply text as JSON. A 2xx reply that is not JSON throws a ValidationError naming the
 * function; JSON.parse throws only SyntaxError, so that is the one class caught.
 */
function parseReply(text: string, functionName: string): unknown {
  const where = `FunctionPoster.post: ${functionName} reply`;
  try {
    const reply: unknown = JSON.parse(text);
    return reply;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError(`${where}: not JSON: ${error.message}`, { cause: error, where });
    }
    throw error;
  }
}

export function functionClient(config: FunctionPosterConfig): FunctionClient {
  const poster = new FunctionPoster(config);
  return {
    push: (lines: InboundLine[], signal: AbortSignal | undefined) => poster.post({ lines }, signal),
  };
}
