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
import { type HttpZip, openHttpZip, openZipEntry, readZipDirectory } from "./zip.ts";

export const FCC_AMATEUR_ZIP = "https://data.fcc.gov/download/pub/uls/complete/l_amat.zip";

/** Fewer records than this means a truncated or wrong file (the real one has ~1.5M of each). */
export const MIN_RECORDS: UlsCounts = { HD: 500_000, EN: 500_000, AM: 500_000 };

const RETRY_AFTER_MS = 12 * 3_600_000;

/** load-licenses, one method per action. */
export interface LicenseClient {
  status(): Promise<LicenseLoad | null>;
  begin(version: string): Promise<number>;
  rows(load: number, kind: UlsKind, rows: UlsRow[]): Promise<number>;
  finish(load: number, counts: UlsCounts): Promise<void>;
}

export function licenseClient(
  post: (body: LoadLicensesRequest) => Promise<unknown>,
): LicenseClient {
  const field = async (body: LoadLicensesRequest, name: string): Promise<unknown> =>
    ((await post(body)) as Record<string, unknown> | null)?.[name];
  return {
    status: async () => (await field({ action: "status" }, "load") ?? null) as LicenseLoad | null,
    begin: async (version) => Number(await field({ action: "begin", version }, "load")),
    rows: async (load, kind, rows) =>
      Number(await field({ action: "rows", load, kind, rows }, "inserted")),
    async finish(load, counts) {
      await post({ action: "finish", load, counts });
    },
  };
}

/** True when `version` should be loaded, given the newest load. */
export function shouldImport(version: string, latest: LicenseLoad | null, now: Date): boolean {
  if (!latest) return true;
  if (latest.version === version && (latest.status === "ready" || latest.status === "applied")) {
    return false;
  }
  if (latest.status === "ready") return true; // a newer file than the one waiting to apply
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

/** Abortable read that fails when the server goes quiet. */
async function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no data for ${ms / 1000} s`)), ms);
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
  const { log, signal } = options;
  const batchSize = options.batchSize ?? 5_000;
  const minRecords = options.minRecords ?? MIN_RECORDS;
  const retryDelays = options.retryDelaysMs ?? [5_000, 30_000];

  const entries = await readZipDirectory(zip);
  const entryFor = (kind: UlsKind) => {
    const entry = entries.find((e) => e.name === `${kind}.dat`);
    if (!entry) throw new Error(`${kind}.dat is not in the zip`);
    return entry;
  };
  ULS_KINDS.forEach(entryFor);

  const load = await client.begin(zip.version);
  const staged: UlsCounts = { HD: 0, EN: 0, AM: 0 };

  async function push(kind: UlsKind, rows: UlsRow[]): Promise<void> {
    for (let attempt = 0;; attempt++) {
      try {
        staged[kind] += await client.rows(load, kind, rows);
        return;
      } catch (error) {
        const delay = retryDelays[attempt];
        if (delay === undefined || signal.aborted) throw error;
        await abortableSleep(delay, signal);
      }
    }
  }

  for (const kind of ULS_KINDS) {
    const reader = (await openZipEntry(zip, entryFor(kind)))
      .pipeThrough(new TextDecoderStream())
      .getReader();
    const records = new UlsRecords(kind);
    let batch: UlsRow[] = [];
    let skipped = 0;
    const take = async (lines: string[]) => {
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
    };
    try {
      for (;;) {
        if (signal.aborted) throw new Error("license import aborted");
        const { done, value } = await readWithin(reader, options.readTimeoutMs ?? 120_000);
        if (done) break;
        await take(records.push(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    await take(records.flush());
    if (batch.length > 0) await push(kind, batch);
    log(`${kind}.dat: ${staged[kind]} staged, ${skipped} skipped`);
    if (staged[kind] < minRecords[kind]) {
      throw new Error(
        `${kind}.dat has ${staged[kind]} records, expected at least ${minRecords[kind]}`,
      );
    }
  }

  await client.finish(load, staged);
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
  if (!shouldImport(zip.version, latest, (options.now ?? (() => new Date()))())) return null;
  options.log(`loading ${options.zipUrl} (${zip.version})`);
  const staged = await importLicenses(zip, options.client, options);
  options.log(`load finished: ${JSON.stringify(staged)}; pg_cron applies it within the hour`);
  return staged;
}

/** Check now and then until `signal` aborts. A failed check is logged and retried next time. */
export async function runLicenseImports(options: LicenseImportLoop): Promise<void> {
  const { signal, log } = options;
  await abortableSleep(options.firstCheckMs ?? 5 * 60_000, signal);
  while (!signal.aborted) {
    try {
      await checkLicenses(options);
    } catch (error) {
      if (!signal.aborted) {
        log(`load failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await abortableSleep(options.checkMs ?? 6 * 3_600_000, signal);
  }
}
