// The weekly reference list load (decision 2 of
// docs/superpowers/specs/2026-10-26-reference-profiles-design.md). Once a day the inbound worker HEADs
// each program's list (POTA parks, SOTA summits, WWFF references); when the program's last
// applied load began at least a week ago and the file's Last-Modified is newer, it streams the file,
// parses it with _shared/reference_catalog.ts and pushes the rows in batches to the
// load-references Edge Function, which stages them. pg_cron swaps a finished load into
// reference_catalog within the hour; SQL refuses a truncated list (decision 3).
//
// One program at a time, so at most one download is open. The lists change daily (POTA's) or
// often, so the week is what keeps it to one download per program a week. An unfinished load (a
// failure, a crash, a deploy mid-load) is retried after twelve hours, not at once, and a version
// whose load was refused is never downloaded again; a newer file is.

import {
  type ErrorContext,
  FunctionCallError,
  TimeoutError,
  ValidationError,
} from "../supabase/functions/_shared/errors.ts";
import { userAgent } from "../supabase/functions/_shared/http.ts";
import {
  catalogFile,
  type LoadReferencesRequest,
  type ProgramLoadStatus,
  REFERENCE_PROGRAMS,
  referenceBeginReplySchema,
  ReferenceCatalogParser,
  type ReferenceCatalogRow,
  referenceFinishReplySchema,
  type ReferenceFinishState,
  type ReferenceLoadStatus,
  type ReferenceProgram,
  referenceRowsReplySchema,
  referenceStatusReplySchema,
} from "../supabase/functions/_shared/reference_catalog.ts";
import { parseWith } from "../supabase/functions/_shared/validate.ts";
import type { CatalogUrls } from "./config.ts";
import { readWithin } from "./licenses.ts";
import { abortableSleep } from "./telnet.ts";

/** How old a program's applied list must be before a newer file is loaded. */
export const RELOAD_AFTER_MS = 7 * 24 * 3_600_000;
/** How long an unfinished load waits before it is tried again. */
export const RETRY_AFTER_MS = 12 * 3_600_000;
/** How long a GET may wait for response headers; the body then has the read timeout. */
const HEADER_TIMEOUT_MS = 60_000;
const HEAD_TIMEOUT_MS = 30_000;

/** The import stopped before its data did: the signal aborted. */
class CatalogImportError extends Error {
  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
    this.name = "CatalogImportError";
  }
}

/** load-references, one method per action. */
export interface ReferenceClient {
  status(): Promise<ReferenceLoadStatus>;
  begin(program: ReferenceProgram, version: string): Promise<number>;
  /** Stages a batch; returns the load's rows staged so far (right even for a retried batch). */
  rows(load: number, rows: ReferenceCatalogRow[]): Promise<number>;
  /** Ends staging: finished, or refused when SQL finds it incomplete or below the floor. */
  finish(load: number, rows: number): Promise<ReferenceFinishState>;
  /** Abandons the load and deletes its staged rows. */
  abandon(load: number, error: string): Promise<void>;
}

export function referenceClient(
  post: (body: LoadReferencesRequest) => Promise<unknown>,
): ReferenceClient {
  return {
    async status(): Promise<ReferenceLoadStatus> {
      const raw = await post({ action: "status" });
      return parseWith(
        referenceStatusReplySchema,
        raw,
        "referenceClient.status: load-references reply",
      ).status;
    },
    async begin(program, version): Promise<number> {
      const raw = await post({ action: "begin", program, version });
      return parseWith(
        referenceBeginReplySchema,
        raw,
        "referenceClient.begin: load-references reply",
      ).load;
    },
    async rows(load, rows): Promise<number> {
      const raw = await post({ action: "rows", load, rows });
      return parseWith(
        referenceRowsReplySchema,
        raw,
        "referenceClient.rows: load-references reply",
      ).staged;
    },
    async finish(load, rows): Promise<ReferenceFinishState> {
      const raw = await post({ action: "finish", load, rows });
      return parseWith(
        referenceFinishReplySchema,
        raw,
        "referenceClient.finish: load-references reply",
      ).state;
    },
    async abandon(load, error): Promise<void> {
      await post({ action: "abandon", load, error });
    },
  };
}

/** True when `version` (a Last-Modified) is later than `than`; when either is not a date, when they differ. */
function isNewer(version: string, than: string): boolean {
  const a = Date.parse(version);
  const b = Date.parse(than);
  if (Number.isFinite(a) && Number.isFinite(b)) {
    return a > b;
  }
  return version !== than;
}

function ageMs(at: string, now: Date): number {
  return now.getTime() - new Date(at).getTime();
}

/** True when the file at `version` should be loaded, given the program's loads. */
export function shouldLoad(
  version: string,
  status: ProgramLoadStatus,
  now: Date,
): boolean {
  const newest = status.newest;
  if (newest !== null) {
    // Loaded, waiting to apply, or refused: never this version again.
    if (
      newest.version === version &&
      (newest.state === "applied" || newest.state === "finished" ||
        newest.state === "refused")
    ) {
      return false;
    }
    // A load waiting to apply goes first; the next check sees it applied.
    if (newest.state === "finished") {
      return false;
    }
    // An unfinished load (staging, or abandoned) is retried after the backoff.
    if (
      (newest.state === "staging" || newest.state === "abandoned") &&
      ageMs(newest.started_at, now) < RETRY_AFTER_MS
    ) {
      return false;
    }
  }
  const applied = status.applied;
  if (applied === null) {
    return true;
  }
  // The week runs from when the applied load began, which was during a daily check, not from
  // applied_at: that is later by the download and the wait for the hourly swap, so the seventh
  // check would always find it a little under a week old and every load would wait for the eighth.
  return ageMs(applied.started_at, now) >= RELOAD_AFTER_MS &&
    isNewer(version, applied.version);
}

export interface CatalogImportOptions {
  log: (message: string) => void;
  signal: AbortSignal;
  fetchFn: typeof fetch;
  now: () => Date;
  /** Rows per load-references request (MAX_REFERENCE_ROWS_PER_REQUEST at most). */
  batchSize?: number;
  /** Give up on the download when no data arrives for this long. */
  readTimeoutMs?: number;
  /** Give up on a GET whose response headers take this long. */
  headerTimeoutMs?: number;
  /** Waits between attempts at one batch; its length is the number of retries. */
  retryDelaysMs?: number[];
}

export interface CatalogImport {
  load: number;
  version: string;
  state: ReferenceFinishState;
  staged: number;
  skipped: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// TypeScript keeps `signal.aborted` narrowed across awaits after a check; this reads it afresh.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** The file's Last-Modified from a HEAD, sent with the inbound worker's User-Agent. */
export async function catalogVersion(
  url: string,
  options: CatalogImportOptions,
): Promise<string> {
  const fetchFn = options.fetchFn;
  const head = await fetchFn(url, {
    method: "HEAD",
    headers: { "User-Agent": userAgent() },
    signal: AbortSignal.any([
      options.signal,
      AbortSignal.timeout(HEAD_TIMEOUT_MS),
    ]),
  });
  if (head.body !== null) {
    await head.body.cancel();
  }
  if (!head.ok) {
    throw new FunctionCallError(`HEAD ${url}: HTTP ${String(head.status)}`, {
      cause: undefined,
      status: head.status,
    });
  }
  const lastModified = head.headers.get("last-modified");
  if (lastModified === null || lastModified.trim() === "") {
    throw new ValidationError(`HEAD ${url}: no Last-Modified`, {
      cause: undefined,
      where: `catalogVersion: HEAD ${url} headers`,
    });
  }
  return lastModified.trim();
}

/** GET with the User-Agent; only the wait for headers is bounded, so a slow body is not cut off. */
async function openDownload(
  url: string,
  options: CatalogImportOptions,
): Promise<Response> {
  let headerTimeoutMs = HEADER_TIMEOUT_MS;
  if (options.headerTimeoutMs !== undefined) {
    headerTimeoutMs = options.headerTimeoutMs;
  }
  const headers = new AbortController();
  function abortHeaders(): void {
    headers.abort(
      new TimeoutError(
        `GET ${url}: no response within ${String(headerTimeoutMs)} ms`,
        {
          cause: undefined,
        },
      ),
    );
  }
  const timer = setTimeout(abortHeaders, headerTimeoutMs);
  const fetchFn = options.fetchFn;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "User-Agent": userAgent() },
      signal: AbortSignal.any([options.signal, headers.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.body !== null) {
      await res.body.cancel();
    }
    throw new FunctionCallError(`GET ${url}: HTTP ${String(res.status)}`, {
      cause: undefined,
      status: res.status,
    });
  }
  return res;
}

/** Abandons a failed load. Best effort: a failed abandon is logged, so the load's own error is the one thrown. */
async function abandonLoad(
  client: ReferenceClient,
  load: number,
  loadError: unknown,
  log: (message: string) => void,
): Promise<void> {
  try {
    await client.abandon(load, errorMessage(loadError));
  } catch (error) {
    // Anything that is not an Error is thrown.
    if (!(error instanceof Error)) {
      throw error;
    }
    log(`abandon failed: ${error.message}`);
  }
}

/**
 * Downloads one program's list and stages it as one load, then finishes it. `version` is the
 * HEAD's Last-Modified; a GET that names another (the file changed in between) fails the load
 * rather than stage bytes under the wrong version. A failure abandons the load and throws.
 */
export async function importCatalog(
  program: ReferenceProgram,
  url: string,
  version: string,
  client: ReferenceClient,
  options: CatalogImportOptions,
): Promise<CatalogImport> {
  const signal = options.signal;
  let batchSize = 2_000;
  if (options.batchSize !== undefined) {
    batchSize = options.batchSize;
  }
  let retryDelays = [5_000, 30_000];
  if (options.retryDelaysMs !== undefined) {
    retryDelays = options.retryDelaysMs;
  }
  let readTimeoutMs = 120_000;
  if (options.readTimeoutMs !== undefined) {
    readTimeoutMs = options.readTimeoutMs;
  }
  const parser = new ReferenceCatalogParser(program, options.now());
  const file = catalogFile(program);

  const load = await client.begin(program, version);
  let staged = 0;
  let batch: ReferenceCatalogRow[] = [];

  async function push(rows: ReferenceCatalogRow[]): Promise<void> {
    for (let attempt = 0;; attempt++) {
      try {
        // The total, not this batch's inserts: a retry after a lost reply inserts nothing.
        staged = await client.rows(load, rows);
        return;
      } catch (error) {
        // Kept outside the loop boundary: a failed post (HTTP, network, timeout, a bad reply) is
        // retried after each delay in turn, then thrown. Anything that is not an Error is thrown.
        const delay = retryDelays[attempt];
        if (
          !(error instanceof Error) || delay === undefined || signal.aborted
        ) {
          throw error;
        }
        await abortableSleep(delay, signal);
      }
    }
  }

  async function take(rows: ReferenceCatalogRow[]): Promise<void> {
    for (const row of rows) {
      batch.push(row);
      if (batch.length >= batchSize) {
        await push(batch);
        batch = [];
      }
    }
  }

  async function stage(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let readToEnd = false;
    try {
      for (;;) {
        if (isAborted(signal)) {
          throw new CatalogImportError(`${file}: import aborted`, {
            cause: undefined,
          });
        }
        const result = await readWithin(reader, readTimeoutMs, file);
        if (result.done) {
          break;
        }
        await take(parser.push(result.value));
      }
      readToEnd = true;
    } finally {
      // Stop the download when the file was not read to its end. On a stream that errored,
      // cancel rejects with the error the read already threw, so the same error goes on.
      if (!readToEnd) {
        await reader.cancel();
      }
    }
    await take(parser.flush());
    if (batch.length > 0) {
      await push(batch);
      batch = [];
    }
  }

  try {
    const res = await openDownload(url, options);
    const body = res.body;
    const sent = res.headers.get("last-modified");
    if (sent !== null && sent.trim() !== version) {
      if (body !== null) {
        await body.cancel();
      }
      throw new ValidationError(
        `GET ${url}: Last-Modified ${sent}, but HEAD said ${version}`,
        {
          cause: undefined,
          where: `importCatalog: GET ${url} headers`,
        },
      );
    }
    if (body === null) {
      throw new ValidationError(`GET ${url}: no body`, {
        cause: undefined,
        where: `importCatalog: GET ${url}`,
      });
    }
    await stage(body);
    const state = await client.finish(load, staged);
    return { load, version, state, staged, skipped: parser.skipped };
  } catch (error) {
    // Kept outside the loop boundary: free the staged rows now rather than at the next begin,
    // then throw the load's own error on.
    await abandonLoad(client, load, error, options.log);
    throw error;
  }
}

export interface CatalogImportLoop extends CatalogImportOptions {
  urls: CatalogUrls;
  client: ReferenceClient;
  /** Wait before the first check, so restarts settle first. */
  firstCheckMs?: number;
  checkMs?: number;
}

/**
 * One check: each program in turn, its list loaded when due. A program that fails is logged and
 * the next one still runs. Returns the loads made.
 */
export async function checkCatalogs(
  options: CatalogImportLoop,
): Promise<CatalogImport[]> {
  const log = options.log;
  const status = await options.client.status();
  const loads: CatalogImport[] = [];
  for (const program of REFERENCE_PROGRAMS) {
    if (isAborted(options.signal)) {
      break;
    }
    const url = options.urls[program];
    try {
      const version = await catalogVersion(url, options);
      if (!shouldLoad(version, status[program], options.now())) {
        continue;
      }
      log(`${program}: loading ${url} (${version})`);
      const result = await importCatalog(
        program,
        url,
        version,
        options.client,
        options,
      );
      const counts = `${String(result.staged)} staged, ${String(result.skipped)} skipped`;
      log(`${program}: ${counts}, ${result.state}`);
      if (result.state === "refused") {
        log(
          `${program}: refused as incomplete or below the floor; the old list stays`,
        );
      }
      loads.push(result);
    } catch (error) {
      // The per-program boundary: one list failing does not hold up the others. Anything that is
      // not an Error is thrown.
      if (!(error instanceof Error)) {
        throw error;
      }
      if (!isAborted(options.signal)) {
        log(`${program}: load failed: ${error.message}`);
      }
    }
  }
  return loads;
}

/** Check now and then until `signal` aborts. A failed check is logged and retried next time. */
export async function runCatalogImports(
  options: CatalogImportLoop,
): Promise<void> {
  const signal = options.signal;
  let firstCheckMs = 15 * 60_000;
  if (options.firstCheckMs !== undefined) {
    firstCheckMs = options.firstCheckMs;
  }
  let checkMs = 24 * 3_600_000;
  if (options.checkMs !== undefined) {
    checkMs = options.checkMs;
  }
  await abortableSleep(firstCheckMs, signal);
  while (!isAborted(signal)) {
    try {
      await checkCatalogs(options);
    } catch (error) {
      // The loop boundary: a failed check (the status call) is logged and retried at the next one.
      if (!(error instanceof Error)) {
        throw error;
      }
      if (!isAborted(signal)) {
        options.log(`check failed: ${error.message}`);
      }
    }
    await abortableSleep(checkMs, signal);
  }
}
