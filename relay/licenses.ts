// The weekly FCC license load. Every few hours the relay HEADs l_amat.zip;
// when its Last-Modified is not yet loaded it streams HD.dat, EN.dat and
// AM.dat out of the zip (relay/zip.ts), parses them with _shared/uls.ts and
// pushes the rows in batches to the load-licenses Edge Function, which stages
// them. pg_cron swaps a finished load into callsign_licenses within the hour.
//
// The FCC publishes the full file weekly (Sundays), so a check every six hours
// downloads it about once a week. An unfinished load (a failure, a crash, a
// deploy mid-load) is retried after twelve hours, not at once, so a load that
// keeps failing costs the FCC two downloads a day at most.

import {
  type LicenseLoad,
  type LoadLicensesRequest,
  parseUlsRecord,
  ULS_KINDS,
  type UlsCounts,
  type UlsKind,
  UlsRecords,
  type UlsRow,
} from "../supabase/functions/_shared/uls.ts";
import { abortableSleep } from "./telnet.ts";
import { type HttpZip, openHttpZip, openZipEntry, readZipDirectory, type ZipEntry } from "./zip.ts";

/** Fewer records than this means a truncated or wrong file (the real one has ~1.5M of each). */
export const MIN_RECORDS: UlsCounts = { HD: 500_000, EN: 500_000, AM: 500_000 };

const RETRY_AFTER_MS = 12 * 3_600_000;

/** load-licenses, one method per action. */
export interface LicenseClient {
  status(): Promise<LicenseLoad | null>;
  begin(version: string): Promise<number>;
  /** Stages a batch; returns that file's rows staged so far (right even for a retried batch). */
  rows(load: number, kind: UlsKind, rows: UlsRow[]): Promise<number>;
  finish(load: number, counts: UlsCounts): Promise<void>;
  /** Fails the load and empties staging. */
  abandon(load: number, error: string): Promise<void>;
}

export function licenseClient(
  post: (body: LoadLicensesRequest) => Promise<unknown>,
): LicenseClient {
  async function field(body: LoadLicensesRequest, name: string): Promise<unknown> {
    const reply = (await post(body)) as Record<string, unknown> | null;
    if (reply === null || reply === undefined) {
      return undefined;
    }
    return reply[name];
  }
  return {
    async status(): Promise<LicenseLoad | null> {
      let load = await field({ action: "status" }, "load");
      if (load === undefined) {
        load = null;
      }
      return load as LicenseLoad | null;
    },
    begin: async (version) => Number(await field({ action: "begin", version }, "load")),
    rows: async (load, kind, rows) =>
      Number(await field({ action: "rows", load, kind, rows }, "staged")),
    async finish(load, counts): Promise<void> {
      await post({ action: "finish", load, counts });
    },
    async abandon(load, error): Promise<void> {
      await post({ action: "abandon", load, error });
    },
  };
}

/** True when `version` should be loaded, given the newest load. */
export function shouldImport(version: string, latest: LicenseLoad | null, now: Date): boolean {
  if (latest === null) {
    return true;
  }
  if (latest.version === version && (latest.status === "ready" || latest.status === "applied")) {
    return false;
  }
  if (latest.status === "ready") {
    return true; // a newer file than the one waiting to apply
  }
  return latest.status === "applied" ||
    now.getTime() - new Date(latest.started_at).getTime() >= RETRY_AFTER_MS;
}

export interface ImportOptions {
  log: (message: string) => void;
  signal: AbortSignal;
  batchSize?: number;
  minRecords?: UlsCounts;
  /** Give up on the download when no data arrives for this long. */
  readTimeoutMs?: number;
  /** Waits between attempts at one batch; its length is the number of retries. */
  retryDelaysMs?: number[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Abortable read that fails when the server goes quiet. */
async function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>(function arm(_resolve, reject): void {
    timer = setTimeout(function fail(): void {
      reject(new Error(`no data for ${String(ms / 1000)} s`));
    }, ms);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stage every record of the zip as one load and finish it. Returns the rows staged. */
export async function importLicenses(
  zip: HttpZip,
  client: LicenseClient,
  options: ImportOptions,
): Promise<UlsCounts> {
  const log = options.log;
  const signal = options.signal;
  let batchSize = 5_000;
  if (options.batchSize !== null && options.batchSize !== undefined) {
    batchSize = options.batchSize;
  }
  let minRecords = MIN_RECORDS;
  if (options.minRecords !== null && options.minRecords !== undefined) {
    minRecords = options.minRecords;
  }
  let retryDelays = [5_000, 30_000];
  if (options.retryDelaysMs !== null && options.retryDelaysMs !== undefined) {
    retryDelays = options.retryDelaysMs;
  }

  const entries = await readZipDirectory(zip);
  function entryFor(kind: UlsKind): ZipEntry {
    const entry = entries.find((e) => e.name === `${kind}.dat`);
    if (entry === undefined) {
      throw new Error(`${kind}.dat is not in the zip`);
    }
    return entry;
  }
  ULS_KINDS.forEach(entryFor);

  const load = await client.begin(zip.version);
  const staged: UlsCounts = { HD: 0, EN: 0, AM: 0 };

  async function push(kind: UlsKind, rows: UlsRow[]): Promise<void> {
    for (let attempt = 0;; attempt++) {
      try {
        // The total, not this batch's inserts: a retry after a lost reply inserts nothing.
        staged[kind] = await client.rows(load, kind, rows);
        return;
      } catch (error) {
        const delay = retryDelays[attempt];
        if (delay === undefined || signal.aborted) {
          throw error;
        }
        await abortableSleep(delay, signal);
      }
    }
  }

  async function stageFile(kind: UlsKind): Promise<void> {
    const reader = (await openZipEntry(zip, entryFor(kind)))
      .pipeThrough(new TextDecoderStream())
      .getReader();
    const records = new UlsRecords(kind);
    let batch: UlsRow[] = [];
    let skipped = 0;
    async function take(lines: string[]): Promise<void> {
      for (const line of lines) {
        const row = parseUlsRecord(kind, line);
        if (row === null) {
          skipped += 1;
          continue;
        }
        batch.push(row);
        if (batch.length >= batchSize) {
          await push(kind, batch);
          batch = [];
        }
      }
    }
    try {
      for (;;) {
        if (signal.aborted) {
          throw new Error("license import aborted");
        }
        let readTimeoutMs = 120_000;
        if (options.readTimeoutMs !== null && options.readTimeoutMs !== undefined) {
          readTimeoutMs = options.readTimeoutMs;
        }
        const result = await readWithin(reader, readTimeoutMs);
        if (result.done) {
          break;
        }
        await take(records.push(result.value));
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // Best effort: the read's own error is the one to report.
      }
      throw error;
    }
    await take(records.flush());
    if (batch.length > 0) {
      await push(kind, batch);
    }
    log(`${kind}.dat: ${String(staged[kind])} staged, ${String(skipped)} skipped`);
    if (staged[kind] < minRecords[kind]) {
      throw new Error(
        `${kind}.dat has ${String(staged[kind])} records, expected at least ${
          String(minRecords[kind])
        }`,
      );
    }
  }

  try {
    for (const kind of ULS_KINDS) {
      await stageFile(kind);
    }
    await client.finish(load, staged);
  } catch (error) {
    // Free the staged rows now rather than at the next begin, 12 hours on. Best
    // effort: begin empties staging anyway.
    try {
      await client.abandon(load, errorMessage(error));
    } catch {
      // Ignored: the load's own error is the one to report.
    }
    throw error;
  }
  return staged;
}

export interface LicenseImportLoop extends ImportOptions {
  zipUrl: string;
  client: LicenseClient;
  /** Wait before the first check, so restarts settle first. */
  firstCheckMs?: number;
  checkMs?: number;
  now?: () => Date;
  fetchFn?: typeof fetch;
}

/** One check: load the file if it is new. Returns the rows staged, or null when nothing was due. */
export async function checkLicenses(options: LicenseImportLoop): Promise<UlsCounts | null> {
  const zip = await openHttpZip(options.zipUrl, options.signal, options.fetchFn);
  const latest = await options.client.status();
  let now: Date;
  const nowFn = options.now;
  if (nowFn !== null && nowFn !== undefined) {
    now = nowFn();
  } else {
    now = new Date();
  }
  if (!shouldImport(zip.version, latest, now)) {
    return null;
  }
  options.log(`loading ${options.zipUrl} (${zip.version})`);
  const staged = await importLicenses(zip, options.client, options);
  options.log(`load finished: ${JSON.stringify(staged)}; pg_cron applies it within the hour`);
  return staged;
}

/** Check now and then until `signal` aborts. A failed check is logged and retried next time. */
export async function runLicenseImports(options: LicenseImportLoop): Promise<void> {
  const signal = options.signal;
  const log = options.log;
  let firstCheckMs = 5 * 60_000;
  if (options.firstCheckMs !== null && options.firstCheckMs !== undefined) {
    firstCheckMs = options.firstCheckMs;
  }
  await abortableSleep(firstCheckMs, signal);
  while (!signal.aborted) {
    try {
      await checkLicenses(options);
    } catch (error) {
      if (!signal.aborted) {
        log(`load failed: ${errorMessage(error)}`);
      }
    }
    let checkMs = 6 * 3_600_000;
    if (options.checkMs !== null && options.checkMs !== undefined) {
      checkMs = options.checkMs;
    }
    await abortableSleep(checkMs, signal);
  }
}
