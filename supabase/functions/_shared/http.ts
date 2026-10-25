// fetch wrapper: identifies Long Lines to upstream APIs and never hangs.

import { FunctionCallError } from "./errors.ts";

const DEFAULT_PROJECT_URL = "https://github.com/sonyccd/longlines";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOptions {
  timeoutMs?: number;
}

/** "LongLines/0.1 (+<project url>)", project url from LONGLINES_USER_AGENT_URL. */
export function userAgent(): string {
  let projectUrl = DEFAULT_PROJECT_URL;
  const configured = Deno.env.get("LONGLINES_USER_AGENT_URL");
  if (configured !== undefined) {
    const trimmed = configured.trim();
    if (trimmed !== "") {
      projectUrl = trimmed;
    }
  }
  return `LongLines/0.1 (+${projectUrl})`;
}

async function fetchOk(url: string, accept: string, options: FetchOptions): Promise<Response> {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (options.timeoutMs !== undefined) {
    timeoutMs = options.timeoutMs;
  }
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: accept },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    if (response.body !== null) {
      await response.body.cancel();
    }
    throw new FunctionCallError(`GET ${url} failed: HTTP ${String(response.status)}`, {
      cause: undefined,
      status: response.status,
    });
  }
  return response;
}

/**
 * GET a JSON document, unvalidated: the caller parses it against its schema. Throws
 * FunctionCallError on non-2xx, and the runtime's error on a timeout or invalid JSON.
 */
export async function fetchJson(url: string, options: FetchOptions): Promise<unknown> {
  const response = await fetchOk(url, "application/json", options);
  const body: unknown = await response.json();
  return body;
}

/**
 * GET a text document, trimmed. Throws FunctionCallError on non-2xx, and the
 * runtime's error on a timeout.
 */
export async function fetchText(url: string, options: FetchOptions): Promise<string> {
  const response = await fetchOk(url, "text/plain, */*", options);
  return (await response.text()).trim();
}
