// The weekly ISED amateur certificate and special callsign loads. Once a day the inbound worker
// HEADs each zip; when the last applied load began at least a week ago and the file's
// Last-Modified is newer, it GETs the zip into memory (~2.3 MB for amateur_delim.zip), reads the
// text entry through inbound/zip.ts (openZipEntry over an in-memory RangeSource), parses it with
// _shared/ised.ts or _shared/ised_special.ts, and posts batches to load-ised-licenses or
// load-ised-special. SQL enforces the floor at finish, and pg_cron's apply_license_loads() swaps
// each finished load in within the hour.

import { z } from "zod";
import {
  ConfigError,
  type ErrorContext,
  FunctionCallError,
  TimeoutError,
  ValidationError,
} from "../supabase/functions/_shared/errors.ts";
import { userAgent } from "../supabase/functions/_shared/http.ts";
import {
  type IsedLoadStatus,
  isedLoadStatusSchema,
  IsedRecords,
  type IsedRow,
  type LoadIsedLicensesRequest,
  MAX_ISED_ROWS_PER_REQUEST,
} from "../supabase/functions/_shared/ised.ts";
import {
  IsedSpecialRecords,
  type IsedSpecialRow,
  type LoadIsedSpecialRequest,
} from "../supabase/functions/_shared/ised_special.ts";
import { reportError } from "../supabase/functions/_shared/sentry.ts";
import { parseWith } from "../supabase/functions/_shared/validate.ts";
import { isLocalHost } from "./config.ts";
import { readWithin } from "./licenses.ts";
import { abortableSleep } from "./telnet.ts";
import {
  openZipEntry,
  type RangeSource,
  readZipDirectory,
  STREAM_HEADER_TIMEOUT_MS,
} from "./zip.ts";

/** Zip entry name for ISED amateur certificates. */
export const ISED_AMATEUR_ENTRY = "amateur_delim.txt";
/** Zip entry name for ISED special callsigns. */
export const ISED_SPECIAL_ENTRY = "special_callsign.txt";

/** How old the applied load must be before a newer nightly file is loaded. */
export const RELOAD_AFTER_MS = 7 * 24 * 3_600_000;
/** How long an unfinished load waits before it is tried again. */
export const RETRY_AFTER_MS = 12 * 3_600_000;

const HEAD_TIMEOUT_MS = 30_000;
const MAX_ISED_ZIP_BYTES = 32 * 1024 * 1024;

/** The import stopped before its data did: the signal aborted. */
class IsedImportError extends Error {
  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
    this.name = "IsedImportError";
  }
}

interface BeginReply {
  load: number;
}

const beginReplySchema: z.ZodType<BeginReply> = z.strictObject({
  load: z.number(),
});

interface RowsReply {
  staged: number;
}

const rowsReplySchema: z.ZodType<RowsReply> = z.strictObject({
  staged: z.number(),
});

/** Shared client interface for load-ised-licenses and load-ised-special. */
export interface IsedLoadClient<Row> {
  status(): Promise<IsedLoadStatus>;
  begin(version: string): Promise<number>;
  /** Stages a batch; returns the cumulative staged row count. */
  rows(load: number, rows: Row[]): Promise<number>;
  finish(load: number, rows: number): Promise<void>;
  /** Fails the load and empties staging. */
  abandon(load: number, error: string): Promise<void>;
}

interface IsedParser<Row> {
  readonly skipped: number;
  push(chunk: string): Row[];
  flush(): Row[];
}

function createIsedClient<Row>(
  post: (
    body:
      | { action: "status" }
      | { action: "begin"; version: string }
      | { action: "rows"; load: number; rows: Row[] }
      | { action: "finish"; load: number; rows: number }
      | { action: "abandon"; load: number; error: string },
  ) => Promise<unknown>,
  clientName: string,
  functionName: string,
): IsedLoadClient<Row> {
  return {
    async status(): Promise<IsedLoadStatus> {
      const raw = await post({ action: "status" });
      return parseWith(
        isedLoadStatusSchema,
        raw,
        `${clientName}.status: ${functionName} reply`,
      );
    },
    async begin(version): Promise<number> {
      const raw = await post({ action: "begin", version });
      return parseWith(
        beginReplySchema,
        raw,
        `${clientName}.begin: ${functionName} reply`,
      ).load;
    },
    async rows(load, rows): Promise<number> {
      const raw = await post({ action: "rows", load, rows });
      return parseWith(
        rowsReplySchema,
        raw,
        `${clientName}.rows: ${functionName} reply`,
      ).staged;
    },
    async finish(load, rows): Promise<void> {
      await post({ action: "finish", load, rows });
    },
    async abandon(load, error): Promise<void> {
      await post({ action: "abandon", load, error });
    },
  };
}

export function isedLicenseClient(
  post: (body: LoadIsedLicensesRequest) => Promise<unknown>,
): IsedLoadClient<IsedRow> {
  return createIsedClient(post, "isedLicenseClient", "load-ised-licenses");
}

export function isedSpecialClient(
  post: (body: LoadIsedSpecialRequest) => Promise<unknown>,
): IsedLoadClient<IsedSpecialRow> {
  return createIsedClient(post, "isedSpecialClient", "load-ised-special");
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

/** True when the file at `version` should be loaded, given the authority's load status. */
export function shouldImportIsed(
  version: string,
  status: IsedLoadStatus,
  now: Date,
): boolean {
  const latest = status.load;
  if (latest === null) {
    return true;
  }
  if (latest.status === "ready") {
    return false;
  }
  if (latest.status === "loading" || latest.status === "failed") {
    if (ageMs(latest.started_at, now) < RETRY_AFTER_MS) {
      return false;
    }
    if (status.newestAppliedStartedAt === null) {
      return true;
    }
    return ageMs(status.newestAppliedStartedAt, now) >= RELOAD_AFTER_MS;
  }
  if (!isNewer(version, latest.version)) {
    return false;
  }
  let appliedAt = latest.started_at;
  if (status.newestAppliedStartedAt !== null) {
    appliedAt = status.newestAppliedStartedAt;
  }
  return ageMs(appliedAt, now) >= RELOAD_AFTER_MS;
}

export interface IsedImportOptions {
  log: (message: string) => void;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
  /** Rows per Edge Function request (at most MAX_ISED_ROWS_PER_REQUEST). */
  batchSize?: number;
  /** Give up on the download when no data arrives for this long. */
  readTimeoutMs?: number;
  /** Give up on a GET whose response headers take this long. */
  headerTimeoutMs?: number;
  /** Waits between attempts at one batch; its length is the number of retries. */
  retryDelaysMs?: number[];
}

export interface IsedImportResult {
  load: number;
  version: string;
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

function assertAllowedZipUrl(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLocalHost(parsed.hostname))
  ) {
    throw new ConfigError(
      `${url}: https is required outside local development`,
      {
        cause: undefined,
      },
    );
  }
}

/** The zip's Last-Modified from a HEAD, sent with the inbound worker's User-Agent. */
export async function isedZipVersion(
  url: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
): Promise<string> {
  assertAllowedZipUrl(url);
  const head = await fetchFn(url, {
    method: "HEAD",
    headers: { "User-Agent": userAgent() },
    signal: AbortSignal.any([signal, AbortSignal.timeout(HEAD_TIMEOUT_MS)]),
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
      where: `isedZipVersion: HEAD ${url} headers`,
    });
  }
  return lastModified.trim();
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function memoryRangeSource(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.length,
    bytes(start: number, end: number): Promise<Uint8Array> {
      return Promise.resolve(bytes.subarray(start, end));
    },
    stream(start: number, end: number): Promise<ReadableStream<Uint8Array>> {
      const slice = bytes.slice(start, end);
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      );
    },
  };
}

/** GET the full zip into memory; only the wait for headers is bounded by headerTimeoutMs. */
async function downloadZipBytes(
  url: string,
  version: string,
  entryName: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
  headerTimeoutMs: number,
  readTimeoutMs: number,
): Promise<Uint8Array> {
  assertAllowedZipUrl(url);
  const headers = new AbortController();
  function abortHeaders(): void {
    headers.abort(
      new TimeoutError(
        `GET ${url}: no response within ${String(headerTimeoutMs)} ms`,
        { cause: undefined },
      ),
    );
  }
  const timer = setTimeout(abortHeaders, headerTimeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "User-Agent": userAgent() },
      signal: AbortSignal.any([signal, headers.signal]),
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
        where: `downloadZipBytes: GET ${url} headers`,
      },
    );
  }
  if (body === null) {
    throw new ValidationError(`GET ${url}: no body`, {
      cause: undefined,
      where: `downloadZipBytes: GET ${url}`,
    });
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let readToEnd = false;
  try {
    for (;;) {
      if (isAborted(signal)) {
        throw new IsedImportError(`${entryName}: import aborted`, {
          cause: undefined,
        });
      }
      const result = await readWithin(reader, readTimeoutMs, url);
      if (result.done) {
        break;
      }
      total += result.value.length;
      if (total > MAX_ISED_ZIP_BYTES) {
        throw new ValidationError(
          `GET ${url}: zip larger than ${String(MAX_ISED_ZIP_BYTES)} bytes`,
          {
            cause: undefined,
            where: `downloadZipBytes: GET ${url} body`,
          },
        );
      }
      chunks.push(result.value);
    }
    readToEnd = true;
  } finally {
    if (!readToEnd) {
      await reader.cancel();
    }
  }
  return concatBytes(chunks, total);
}

async function abandonLoad<Row>(
  client: IsedLoadClient<Row>,
  load: number,
  loadError: unknown,
  log: (message: string) => void,
): Promise<void> {
  try {
    await client.abandon(load, errorMessage(loadError));
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    log(`abandon failed: ${error.message}`);
  }
}

async function importIsedZip<Row>(
  url: string,
  version: string,
  entryName: string,
  parser: IsedParser<Row>,
  client: IsedLoadClient<Row>,
  options: IsedImportOptions,
): Promise<IsedImportResult> {
  const signal = options.signal;
  let fetchFn = fetch;
  if (options.fetchFn !== undefined) {
    fetchFn = options.fetchFn;
  }
  let batchSize = MAX_ISED_ROWS_PER_REQUEST;
  if (options.batchSize !== undefined) {
    batchSize = options.batchSize;
  }
  let headerTimeoutMs = STREAM_HEADER_TIMEOUT_MS;
  if (options.headerTimeoutMs !== undefined) {
    headerTimeoutMs = options.headerTimeoutMs;
  }
  let readTimeoutMs = 120_000;
  if (options.readTimeoutMs !== undefined) {
    readTimeoutMs = options.readTimeoutMs;
  }
  let retryDelays = [5_000, 30_000];
  if (options.retryDelaysMs !== undefined) {
    retryDelays = options.retryDelaysMs;
  }

  const load = await client.begin(version);
  let staged = 0;
  let batch: Row[] = [];

  async function push(rows: Row[]): Promise<void> {
    for (let attempt = 0;; attempt++) {
      try {
        staged = await client.rows(load, rows);
        return;
      } catch (error) {
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

  async function take(rows: Row[]): Promise<void> {
    for (const row of rows) {
      batch.push(row);
      if (batch.length >= batchSize) {
        await push(batch);
        batch = [];
      }
    }
  }

  try {
    const zipBytes = await downloadZipBytes(
      url,
      version,
      entryName,
      signal,
      fetchFn,
      headerTimeoutMs,
      readTimeoutMs,
    );
    const source = memoryRangeSource(zipBytes);
    const entries = await readZipDirectory(source);
    const entry = entries.find((e) => e.name === entryName);
    if (entry === undefined) {
      throw new ValidationError(`${entryName} is not in the zip`, {
        cause: undefined,
        where: "importIsedZip: zip directory",
      });
    }
    const reader = (await openZipEntry(source, entry))
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let readToEnd = false;
    try {
      for (;;) {
        if (isAborted(signal)) {
          throw new IsedImportError(`${entryName}: import aborted`, {
            cause: undefined,
          });
        }
        const result = await readWithin(reader, readTimeoutMs, entryName);
        if (result.done) {
          break;
        }
        await take(parser.push(result.value));
      }
      readToEnd = true;
    } finally {
      if (!readToEnd) {
        await reader.cancel();
      }
    }
    await take(parser.flush());
    if (batch.length > 0) {
      await push(batch);
      batch = [];
    }
    options.log(
      `${entryName}: ${String(staged)} staged, ${String(parser.skipped)} skipped`,
    );
    await client.finish(load, staged);
    return { load, version, staged, skipped: parser.skipped };
  } catch (error) {
    await abandonLoad(client, load, error, options.log);
    throw error;
  }
}

/** Downloads amateur_delim.zip, stages amateur_delim.txt rows, and finishes the load. */
export function importIsedLicenses(
  url: string,
  version: string,
  client: IsedLoadClient<IsedRow>,
  options: IsedImportOptions,
): Promise<IsedImportResult> {
  return importIsedZip(
    url,
    version,
    ISED_AMATEUR_ENTRY,
    new IsedRecords(),
    client,
    options,
  );
}

/** Downloads special_callsign.zip, stages special_callsign.txt rows, and finishes the load. */
export function importIsedSpecial(
  url: string,
  version: string,
  client: IsedLoadClient<IsedSpecialRow>,
  options: IsedImportOptions,
): Promise<IsedImportResult> {
  return importIsedZip(
    url,
    version,
    ISED_SPECIAL_ENTRY,
    new IsedSpecialRecords(),
    client,
    options,
  );
}

export interface IsedImportLoop<Row> extends IsedImportOptions {
  zipUrl: string;
  client: IsedLoadClient<Row>;
  /** Wait before the first check, so restarts settle first. */
  firstCheckMs?: number;
  checkMs?: number;
  now?: () => Date;
}

async function checkIsedZip<Row>(
  options: IsedImportLoop<Row>,
  entryName: string,
  createParser: () => IsedParser<Row>,
): Promise<IsedImportResult | null> {
  let fetchFn = fetch;
  if (options.fetchFn !== undefined) {
    fetchFn = options.fetchFn;
  }
  const version = await isedZipVersion(options.zipUrl, options.signal, fetchFn);
  const status = await options.client.status();
  let now: Date;
  const nowFn = options.now;
  if (nowFn !== undefined) {
    now = nowFn();
  } else {
    now = new Date();
  }
  if (!shouldImportIsed(version, status, now)) {
    return null;
  }
  options.log(`loading ${options.zipUrl} (${version})`);
  const result = await importIsedZip(
    options.zipUrl,
    version,
    entryName,
    createParser(),
    options.client,
    options,
  );
  options.log(
    `load finished: ${String(result.staged)} staged, ${
      String(result.skipped)
    } skipped; pg_cron applies it within the hour`,
  );
  return result;
}

/** One check for ISED amateur certificates. Returns the load result, or null when nothing was due. */
export function checkIsedLicenses(
  options: IsedImportLoop<IsedRow>,
): Promise<IsedImportResult | null> {
  return checkIsedZip(options, ISED_AMATEUR_ENTRY, () => new IsedRecords());
}

/** One check for ISED special callsigns. Returns the load result, or null when nothing was due. */
export function checkIsedSpecial(
  options: IsedImportLoop<IsedSpecialRow>,
): Promise<IsedImportResult | null> {
  return checkIsedZip(
    options,
    ISED_SPECIAL_ENTRY,
    () => new IsedSpecialRecords(),
  );
}

async function runIsedZipImports<Row>(
  options: IsedImportLoop<Row>,
  label: string,
  defaultFirstCheckMs: number,
  check: (loop: IsedImportLoop<Row>) => Promise<IsedImportResult | null>,
): Promise<void> {
  const signal = options.signal;
  let firstCheckMs = defaultFirstCheckMs;
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
      await check(options);
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      if (!isAborted(signal)) {
        options.log(`load failed: ${error.message}`);
        reportError(`${label}: load failed: ${error.message}`, error);
      }
    }
    await abortableSleep(checkMs, signal);
  }
}

/** Check daily for ISED amateur certificates until `signal` aborts. */
export function runIsedLicenseImports(
  options: IsedImportLoop<IsedRow>,
): Promise<void> {
  return runIsedZipImports(options, "ised", 10 * 60_000, checkIsedLicenses);
}

/** Check daily for ISED special callsigns until `signal` aborts. */
export function runIsedSpecialImports(
  options: IsedImportLoop<IsedSpecialRow>,
): Promise<void> {
  return runIsedZipImports(
    options,
    "ised-special",
    12 * 60_000,
    checkIsedSpecial,
  );
}
