import { assertEquals, assertRejects } from "@std/assert";
import {
  ConfigError,
  FunctionCallError,
  TimeoutError,
  ValidationError,
} from "../../supabase/functions/_shared/errors.ts";
import type {
  IsedLoadStatus,
  IsedRow,
  LoadIsedLicensesRequest,
} from "../../supabase/functions/_shared/ised.ts";
import type {
  IsedSpecialRow,
  LoadIsedSpecialRequest,
} from "../../supabase/functions/_shared/ised_special.ts";
import type { LicenseLoad } from "../../supabase/functions/_shared/uls.ts";
import { startInbound } from "../inbound.ts";
import {
  checkIsedLicenses,
  checkIsedSpecial,
  importIsedLicenses,
  importIsedSpecial,
  ISED_AMATEUR_ENTRY,
  ISED_SPECIAL_ENTRY,
  isedLicenseClient,
  type IsedLoadClient,
  isedSpecialClient,
  isedZipVersion,
  runIsedLicenseImports,
  runIsedSpecialImports,
  shouldImportIsed,
} from "../ised_licenses.ts";
import { buildZip, serveZip } from "./zip_server.ts";

const OLD_VERSION = "Thu, 22 Oct 2026 06:00:01 GMT";
const VERSION = "Thu, 29 Oct 2026 06:00:01 GMT";
const NOW = new Date("2026-10-29T12:00:00Z");

const AMATEUR_FIXTURE = Deno.readTextFileSync(
  new URL(
    "../../supabase/functions/_shared/__tests__/fixtures/ised-amateur.txt",
    import.meta.url,
  ),
);
const SPECIAL_FIXTURE = Deno.readTextFileSync(
  new URL(
    "../../supabase/functions/_shared/__tests__/fixtures/ised-special.txt",
    import.meta.url,
  ),
);

const AMATEUR_ZIP = buildZip([
  { name: "readme_amat_delim.txt", text: "readme", stored: true },
  { name: ISED_AMATEUR_ENTRY, text: AMATEUR_FIXTURE },
], "");
const SPECIAL_ZIP = buildZip([
  { name: ISED_SPECIAL_ENTRY, text: SPECIAL_FIXTURE },
], "");

function makeLoad(
  status: LicenseLoad["status"],
  version: string,
  hoursAgo: number,
): LicenseLoad {
  return {
    id: 1,
    version,
    status,
    started_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  };
}

function ignoreLog(): void {}

function fakeIsedClient<Row>(
  keyOf: (row: Row) => string,
  options: {
    status?: IsedLoadStatus;
    failRows?: number;
    loseReplies?: number;
    finishError?: string;
    abandonError?: string;
  },
) {
  const batches: { load: number; rows: Row[] }[] = [];
  const finished: number[] = [];
  const abandoned: string[] = [];
  const staged = new Set<string>();
  let failures = 0;
  if (options.failRows !== undefined) {
    failures = options.failRows;
  }
  let lost = 0;
  if (options.loseReplies !== undefined) {
    lost = options.loseReplies;
  }
  const client: IsedLoadClient<Row> = {
    status(): Promise<IsedLoadStatus> {
      if (options.status !== undefined) {
        return Promise.resolve(options.status);
      }
      return Promise.resolve({ load: null, newestAppliedStartedAt: null });
    },
    begin(): Promise<number> {
      return Promise.resolve(17);
    },
    rows(load, rows): Promise<number> {
      if (failures-- > 0) {
        return Promise.reject(new Error("HTTP 503"));
      }
      batches.push({ load, rows });
      for (const row of rows) {
        staged.add(keyOf(row));
      }
      if (lost-- > 0) {
        return Promise.reject(new Error("signal timed out"));
      }
      return Promise.resolve(staged.size);
    },
    finish(_load, rows): Promise<void> {
      if (options.finishError !== undefined) {
        return Promise.reject(new Error(options.finishError));
      }
      finished.push(rows);
      return Promise.resolve();
    },
    abandon(_load, error): Promise<void> {
      if (options.abandonError !== undefined) {
        return Promise.reject(new Error(options.abandonError));
      }
      abandoned.push(error);
      return Promise.resolve();
    },
  };
  return { client, batches, finished, abandoned };
}

Deno.test(
  "shouldImportIsed enforces weekly cadence, newer Last-Modified, and 12-hour retry backoff",
  function (): void {
    // No load yet -> yes.
    assertEquals(
      shouldImportIsed(VERSION, { load: null, newestAppliedStartedAt: null }, NOW),
      true,
    );

    // Last applied began under 7 days ago -> no, even if Last-Modified is newer.
    const recentApplied = makeLoad("applied", OLD_VERSION, 6 * 24);
    assertEquals(
      shouldImportIsed(
        VERSION,
        { load: recentApplied, newestAppliedStartedAt: recentApplied.started_at },
        NOW,
      ),
      false,
    );

    // Newer Last-Modified and a week passed -> yes.
    const weekOldApplied = makeLoad("applied", OLD_VERSION, 7 * 24);
    assertEquals(
      shouldImportIsed(
        VERSION,
        { load: weekOldApplied, newestAppliedStartedAt: weekOldApplied.started_at },
        NOW,
      ),
      true,
    );

    // Same or older Last-Modified after a week -> no.
    assertEquals(
      shouldImportIsed(
        OLD_VERSION,
        { load: weekOldApplied, newestAppliedStartedAt: weekOldApplied.started_at },
        NOW,
      ),
      false,
    );

    // Non-date version strings compare by inequality.
    const nonDateApplied = makeLoad("applied", "v1", 7 * 24);
    assertEquals(
      shouldImportIsed(
        "v2",
        { load: nonDateApplied, newestAppliedStartedAt: nonDateApplied.started_at },
        NOW,
      ),
      true,
    );
    assertEquals(
      shouldImportIsed(
        "v1",
        { load: nonDateApplied, newestAppliedStartedAt: nonDateApplied.started_at },
        NOW,
      ),
      false,
    );

    // Ready load waiting for pg_cron apply -> no.
    assertEquals(
      shouldImportIsed(
        VERSION,
        { load: makeLoad("ready", VERSION, 1), newestAppliedStartedAt: null },
        NOW,
      ),
      false,
    );

    // Unfinished load under 12 hours old -> no.
    assertEquals(
      shouldImportIsed(
        VERSION,
        { load: makeLoad("loading", VERSION, 11), newestAppliedStartedAt: null },
        NOW,
      ),
      false,
    );
    assertEquals(
      shouldImportIsed(
        VERSION,
        { load: makeLoad("failed", VERSION, 11), newestAppliedStartedAt: null },
        NOW,
      ),
      false,
    );

    // Unfinished load 12+ hours old with no prior applied load -> yes.
    assertEquals(
      shouldImportIsed(
        VERSION,
        { load: makeLoad("failed", VERSION, 12), newestAppliedStartedAt: null },
        NOW,
      ),
      true,
    );

    // Unfinished load 12+ hours old respects the 7-day floor since newestAppliedStartedAt.
    assertEquals(
      shouldImportIsed(
        VERSION,
        {
          load: makeLoad("failed", VERSION, 13),
          newestAppliedStartedAt: recentApplied.started_at,
        },
        NOW,
      ),
      false,
    );
    assertEquals(
      shouldImportIsed(
        VERSION,
        {
          load: makeLoad("failed", VERSION, 13),
          newestAppliedStartedAt: weekOldApplied.started_at,
        },
        NOW,
      ),
      true,
    );
  },
);

Deno.test(
  "isedLicenseClient and isedSpecialClient send one action per call and validate replies",
  async function (): Promise<void> {
    const sent: LoadIsedLicensesRequest[] = [];
    const replies: unknown[] = [
      { load: null, newestAppliedStartedAt: null },
      { load: 11 },
      { staged: 1 },
      { ok: true },
      { ok: true },
    ];
    function post(body: LoadIsedLicensesRequest): Promise<unknown> {
      sent.push(body);
      return Promise.resolve(replies.shift());
    }
    const client = isedLicenseClient(post);
    assertEquals(await client.status(), { load: null, newestAppliedStartedAt: null });
    assertEquals(await client.begin(VERSION), 11);
    const row: IsedRow = {
      callsign: "VE3TSS",
      first_name: "Hélène",
      last_name: "McFadden",
      club_name: null,
      province: "ON",
      qualifications: "ACD",
    };
    assertEquals(await client.rows(11, [row]), 1);
    await client.finish(11, 1);
    await client.abandon(11, "boom");
    assertEquals(sent, [
      { action: "status" },
      { action: "begin", version: VERSION },
      { action: "rows", load: 11, rows: [row] },
      { action: "finish", load: 11, rows: 1 },
      { action: "abandon", load: 11, error: "boom" },
    ]);

    const specialSent: LoadIsedSpecialRequest[] = [];
    const specialReplies: unknown[] = [
      { load: null, newestAppliedStartedAt: null },
      { load: 21 },
      { staged: 1 },
      { ok: true },
      { ok: true },
    ];
    const specialClient = isedSpecialClient(function postSpecial(body): Promise<unknown> {
      specialSent.push(body);
      return Promise.resolve(specialReplies.shift());
    });
    assertEquals(await specialClient.status(), { load: null, newestAppliedStartedAt: null });
    assertEquals(await specialClient.begin(VERSION), 21);
    const specialRow: IsedSpecialRow = {
      callsign: "CF3VEDAY",
      beg_date: "2005-05-01",
      end_date: "2005-05-31",
      event_en: "War Museum",
      event_fr: null,
      call_sign_request: null,
      use_by: "VA3ROR",
    };
    assertEquals(await specialClient.rows(21, [specialRow]), 1);
    await specialClient.finish(21, 1);
    await specialClient.abandon(21, "err");
    assertEquals(specialSent.length, 5);

    await assertRejects(
      () => isedLicenseClient(() => Promise.resolve(null)).status(),
      ValidationError,
      "isedLicenseClient.status: load-ised-licenses reply",
    );
    await assertRejects(
      () => isedLicenseClient(() => Promise.resolve({ load: "11" })).begin(VERSION),
      ValidationError,
      "isedLicenseClient.begin: load-ised-licenses reply",
    );
    await assertRejects(
      () => isedSpecialClient(() => Promise.resolve({ staged: 1, extra: true })).rows(21, []),
      ValidationError,
      "isedSpecialClient.rows: load-ised-special reply",
    );
  },
);

Deno.test(
  "isedZipVersion sends User-Agent on HEAD and refuses non-https, non-2xx, or missing Last-Modified",
  async function (): Promise<void> {
    const served = serveZip(await AMATEUR_ZIP, { lastModified: VERSION });
    try {
      const version = await isedZipVersion(served.url, new AbortController().signal, fetch);
      assertEquals(version, VERSION);
      assertEquals(served.requests.length, 1);
      assertEquals(served.requests[0]!.method, "HEAD");
      const ua = served.requests[0]!.userAgent;
      assertEquals(ua !== null && ua.startsWith("LongLines/"), true);
    } finally {
      await served.server.shutdown();
    }

    await assertRejects(
      () =>
        isedZipVersion(
          "http://apc-cap.ic.gc.ca/datafiles/amateur_delim",
          new AbortController().signal,
          fetch,
        ),
      ConfigError,
      "https is required",
    );

    await assertRejects(
      () =>
        isedZipVersion(
          "http://127.0.0.1:9/amateur_delim",
          new AbortController().signal,
          () => Promise.resolve(new Response(null, { status: 503 })),
        ),
      FunctionCallError,
      "HTTP 503",
    );

    const noDate = serveZip(await AMATEUR_ZIP, { lastModified: null });
    try {
      await assertRejects(
        () => isedZipVersion(noDate.url, new AbortController().signal, fetch),
        ValidationError,
        "no Last-Modified",
      );
    } finally {
      await noDate.server.shutdown();
    }
  },
);

Deno.test(
  "importIsedLicenses downloads the zip with User-Agent, stages batched rows, and finishes with the parsed count",
  async function (): Promise<void> {
    const served = serveZip(await AMATEUR_ZIP, { lastModified: VERSION, ignoreRange: true });
    const fake = fakeIsedClient<IsedRow>((r) => r.callsign, { failRows: 1, loseReplies: 1 });
    const logs: string[] = [];
    try {
      const signal = new AbortController().signal;
      const version = await isedZipVersion(served.url, signal, fetch);
      const result = await importIsedLicenses(served.url, version, fake.client, {
        log: (m) => logs.push(m),
        signal,
        batchSize: 3,
        retryDelaysMs: [0, 0],
      });
      assertEquals(result, { load: 17, version: VERSION, staged: 7, skipped: 7 });
      assertEquals(fake.finished, [7]);
      assertEquals(fake.abandoned, []);
      // Batch 1 (3 rows) failed once, then had a lost reply (sent twice), then batch 2 (3) and batch 3 (1).
      assertEquals(fake.batches.map((b) => b.rows.length), [3, 3, 3, 1]);
      assertEquals(fake.batches.every((b) => b.load === 17), true);
      // Both HEAD and GET carry the User-Agent.
      assertEquals(served.requests.map((r) => r.method), ["HEAD", "GET"]);
      assertEquals(
        served.requests.every((r) => r.userAgent !== null && r.userAgent.startsWith("LongLines/")),
        true,
      );
      // UTF-8 accents and literal quotes survive; no address keys leak through.
      const rows = fake.batches.flatMap((b) => b.rows);
      const helene = rows.find((r) => r.callsign === "VE3TSS")!;
      assertEquals(helene, {
        callsign: "VE3TSS",
        first_name: "Hélène",
        last_name: "McFadden",
        club_name: null,
        province: "ON",
        qualifications: "ACD",
      });
      const frank = rows.find((r) => r.callsign === "VA7QSS")!;
      assertEquals(frank.last_name, '"Frank"');
      assertEquals(logs, ["amateur_delim.txt: 7 staged, 7 skipped"]);
    } finally {
      await served.server.shutdown();
    }
  },
);

Deno.test(
  "importIsedLicenses abandons on HTTP 500, stream failure mid-download, missing entry, or finish refusal",
  async function (): Promise<void> {
    const signal = new AbortController().signal;

    // 1. HTTP 500 on GET.
    const failed500 = fakeIsedClient<IsedRow>((r) => r.callsign, {});
    await assertRejects(
      () =>
        importIsedLicenses("http://127.0.0.1:9/amateur_delim", VERSION, failed500.client, {
          log: ignoreLog,
          signal,
          fetchFn: () => Promise.resolve(new Response("boom", { status: 500 })),
        }),
      FunctionCallError,
      "HTTP 500",
    );
    assertEquals(failed500.finished, []);
    assertEquals(failed500.abandoned.length, 1);
    assertEquals(failed500.abandoned[0]!.includes("HTTP 500"), true);

    // 2. Stream error mid-download.
    const midStream = fakeIsedClient<IsedRow>((r) => r.callsign, {});
    await assertRejects(
      () =>
        importIsedLicenses("http://127.0.0.1:9/amateur_delim", VERSION, midStream.client, {
          log: ignoreLog,
          signal,
          fetchFn: () =>
            Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller): void {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.error(new Error("connection reset mid-body"));
                  },
                }),
                { status: 200, headers: { "last-modified": VERSION } },
              ),
            ),
        }),
      Error,
      "connection reset mid-body",
    );
    assertEquals(midStream.abandoned, ["connection reset mid-body"]);

    // 3. Zip without amateur_delim.txt.
    const wrongZip = serveZip(
      await buildZip([{ name: "readme_amat_delim.txt", text: "only readme" }], ""),
      { lastModified: VERSION, ignoreRange: true },
    );
    try {
      const missingEntry = fakeIsedClient<IsedRow>((r) => r.callsign, {});
      await assertRejects(
        () =>
          importIsedLicenses(wrongZip.url, VERSION, missingEntry.client, {
            log: ignoreLog,
            signal,
          }),
        ValidationError,
        "amateur_delim.txt is not in the zip",
      );
      assertEquals(missingEntry.finished, []);
      assertEquals(missingEntry.abandoned, ["amateur_delim.txt is not in the zip"]);
    } finally {
      await wrongZip.server.shutdown();
    }

    // 4. Finish refusal (e.g. SQL floor check).
    const served = serveZip(await AMATEUR_ZIP, { lastModified: VERSION, ignoreRange: true });
    try {
      const floorRefused = fakeIsedClient<IsedRow>((r) => r.callsign, {
        finishError: "ised_license_load_finish: staged only 7 rows (floor 80000)",
      });
      await assertRejects(
        () =>
          importIsedLicenses(served.url, VERSION, floorRefused.client, {
            log: ignoreLog,
            signal,
          }),
        Error,
        "floor 80000",
      );
      assertEquals(floorRefused.abandoned, [
        "ised_license_load_finish: staged only 7 rows (floor 80000)",
      ]);

      // 5. Last-Modified changed between HEAD and GET.
      const changed = fakeIsedClient<IsedRow>((r) => r.callsign, {});
      await assertRejects(
        () =>
          importIsedLicenses(served.url, OLD_VERSION, changed.client, {
            log: ignoreLog,
            signal,
          }),
        ValidationError,
        "but HEAD said",
      );
      assertEquals(changed.abandoned.length, 1);

      // 6. Failed abandon logs and still throws the load's own error.
      const abandonLogs: string[] = [];
      const badAbandon = fakeIsedClient<IsedRow>((r) => r.callsign, {
        failRows: 1,
        abandonError: "abandon HTTP 500",
      });
      await assertRejects(
        () =>
          importIsedLicenses(served.url, VERSION, badAbandon.client, {
            log: (m) => abandonLogs.push(m),
            signal,
            retryDelaysMs: [],
          }),
        Error,
        "HTTP 503",
      );
      assertEquals(abandonLogs, ["abandon failed: abandon HTTP 500"]);
    } finally {
      await served.server.shutdown();
    }
  },
);

Deno.test(
  "importIsedLicenses times out when the download stalls",
  async function (): Promise<void> {
    const fake = fakeIsedClient<IsedRow>((r) => r.callsign, {});
    await assertRejects(
      () =>
        importIsedLicenses("http://127.0.0.1:9/amateur_delim", VERSION, fake.client, {
          log: ignoreLog,
          signal: new AbortController().signal,
          readTimeoutMs: 50,
          fetchFn: () =>
            Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller): void {
                    controller.enqueue(new Uint8Array([80, 75]));
                  },
                }),
                { status: 200, headers: { "last-modified": VERSION } },
              ),
            ),
        }),
      TimeoutError,
      "no data for 0.05 s",
    );
    assertEquals(fake.abandoned.length, 1);
  },
);

Deno.test(
  "importIsedSpecial stages valid special callsigns and skips 2-char prefixes and invalid dates",
  async function (): Promise<void> {
    const served = serveZip(await SPECIAL_ZIP, { lastModified: VERSION, ignoreRange: true });
    const fake = fakeIsedClient<IsedSpecialRow>(
      (r) => `${r.callsign}|${r.beg_date}|${r.end_date}`,
      {},
    );
    try {
      const result = await importIsedSpecial(
        served.url,
        VERSION,
        fake.client,
        { log: ignoreLog, signal: new AbortController().signal, batchSize: 1 },
      );
      assertEquals(result, { load: 17, version: VERSION, staged: 2, skipped: 6 });
      assertEquals(fake.finished, [2]);
      assertEquals(fake.batches.map((b) => b.rows[0]!.callsign), ["CF3VEDAY", "VD2X"]);
    } finally {
      await served.server.shutdown();
    }
  },
);

Deno.test(
  "checkIsedLicenses and checkIsedSpecial skip when a load is not due",
  async function (): Promise<void> {
    const served = serveZip(await AMATEUR_ZIP, { lastModified: VERSION, ignoreRange: true });
    const recent = makeLoad("applied", OLD_VERSION, 24);
    const fake = fakeIsedClient<IsedRow>((r) => r.callsign, {
      status: { load: recent, newestAppliedStartedAt: recent.started_at },
    });
    try {
      const result = await checkIsedLicenses({
        zipUrl: served.url,
        client: fake.client,
        signal: new AbortController().signal,
        log: ignoreLog,
        now: () => NOW,
      });
      assertEquals(result, null);
      assertEquals(fake.batches, []);
      assertEquals(served.requests.map((r) => r.method), ["HEAD"]);
    } finally {
      await served.server.shutdown();
    }

    const servedSpecial = serveZip(await SPECIAL_ZIP, { lastModified: VERSION, ignoreRange: true });
    const fakeSpecial = fakeIsedClient<IsedSpecialRow>(
      (r) => `${r.callsign}|${r.beg_date}|${r.end_date}`,
      {},
    );
    try {
      const result = await checkIsedSpecial({
        zipUrl: servedSpecial.url,
        client: fakeSpecial.client,
        signal: new AbortController().signal,
        log: ignoreLog,
        now: () => NOW,
      });
      assertEquals(result, { load: 17, version: VERSION, staged: 2, skipped: 6 });
    } finally {
      await servedSpecial.server.shutdown();
    }
  },
);

async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

Deno.test(
  "runIsedLicenseImports and runIsedSpecialImports log errors, stop on abort, and rethrow non-Errors",
  async function (): Promise<void> {
    const controller = new AbortController();
    const logs: string[] = [];
    function logAndStop(m: string): void {
      logs.push(m);
      controller.abort();
    }
    await runIsedLicenseImports({
      zipUrl: "http://127.0.0.1:9/amateur_delim",
      client: fakeIsedClient<IsedRow>((r) => r.callsign, {}).client,
      signal: controller.signal,
      log: logAndStop,
      firstCheckMs: 0,
      checkMs: 60_000,
      fetchFn: () => Promise.reject(new Error("connection refused")),
    });
    assertEquals(logs, ["load failed: connection refused"]);

    const specialController = new AbortController();
    const specialLogs: string[] = [];
    await runIsedSpecialImports({
      zipUrl: "http://127.0.0.1:9/special_callsign",
      client: fakeIsedClient<IsedSpecialRow>((r) => r.callsign, {}).client,
      signal: specialController.signal,
      log(m): void {
        specialLogs.push(m);
        specialController.abort();
      },
      firstCheckMs: 0,
      checkMs: 60_000,
      fetchFn: () => Promise.reject(new Error("timeout")),
    });
    assertEquals(specialLogs, ["load failed: timeout"]);

    await assertRejects(() =>
      runIsedLicenseImports({
        zipUrl: "http://127.0.0.1:9/amateur_delim",
        client: fakeIsedClient<IsedRow>((r) => r.callsign, {}).client,
        signal: new AbortController().signal,
        log: ignoreLog,
        firstCheckMs: 0,
        checkMs: 60_000,
        fetchFn: () => rejectWith("non-error"),
      })
    );
  },
);

Deno.test(
  "the inbound worker loads ISED amateur and special callsigns through their Edge Functions with its secret",
  async function (): Promise<void> {
    const servedAmateur = serveZip(await AMATEUR_ZIP, { lastModified: VERSION, ignoreRange: true });
    const servedSpecial = serveZip(await SPECIAL_ZIP, { lastModified: VERSION, ignoreRange: true });
    const amateurRequests: { secret: string | null; body: LoadIsedLicensesRequest }[] = [];
    const specialRequests: { secret: string | null; body: LoadIsedSpecialRequest }[] = [];
    let amateurTotal = 0;
    let specialTotal = 0;

    async function handler(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/inbound-status")) {
        return Response.json({ ok: true });
      }
      if (path.endsWith("/load-ised-licenses")) {
        const body = await req.json() as LoadIsedLicensesRequest;
        amateurRequests.push({ secret: req.headers.get("x-inbound-secret"), body });
        switch (body.action) {
          case "status":
            return Response.json({ load: null, newestAppliedStartedAt: null });
          case "begin":
            return Response.json({ load: 5 });
          case "rows":
            amateurTotal += body.rows.length;
            return Response.json({ staged: amateurTotal });
          case "finish":
          case "abandon":
            return Response.json({ ok: true });
        }
      }
      if (path.endsWith("/load-ised-special")) {
        const body = await req.json() as LoadIsedSpecialRequest;
        specialRequests.push({ secret: req.headers.get("x-inbound-secret"), body });
        switch (body.action) {
          case "status":
            return Response.json({ load: null, newestAppliedStartedAt: null });
          case "begin":
            return Response.json({ load: 6 });
          case "rows":
            specialTotal += body.rows.length;
            return Response.json({ staged: specialTotal });
          case "finish":
          case "abandon":
            return Response.json({ ok: true });
        }
      }
      return new Response("not found", { status: 404 });
    }

    const functions = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
    const logs: string[] = [];
    const inbound = startInbound(
      {
        functionsUrl: `http://127.0.0.1:${functions.addr.port}/functions/v1`,
        inboundSecret: "ised-secret",
        loginCall: "N0CALL",
        healthPort: 0,
        licenseZipUrl: null,
        isedZipUrl: servedAmateur.url,
        isedSpecialZipUrl: servedSpecial.url,
        catalogUrls: null,
        sentry: null,
      },
      [],
      {
        hostname: "127.0.0.1",
        log: (m) => logs.push(m),
        ised: { firstCheckMs: 0, batchSize: 4, now: () => NOW },
        isedSpecial: { firstCheckMs: 0, batchSize: 4, now: () => NOW },
      },
    );
    try {
      const deadline = Date.now() + 5_000;
      while (
        !(
          logs.some((m) => m.startsWith("[ised] load finished")) &&
          logs.some((m) => m.startsWith("[ised-special] load finished"))
        ) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(amateurRequests.map((r) => r.body.action), [
        "status",
        "begin",
        "rows",
        "rows",
        "finish",
      ]);
      assertEquals(amateurRequests.every((r) => r.secret === "ised-secret"), true);
      assertEquals(amateurRequests.at(-1)!.body, { action: "finish", load: 5, rows: 7 });

      assertEquals(specialRequests.map((r) => r.body.action), [
        "status",
        "begin",
        "rows",
        "finish",
      ]);
      assertEquals(specialRequests.every((r) => r.secret === "ised-secret"), true);
      assertEquals(specialRequests.at(-1)!.body, { action: "finish", load: 6, rows: 2 });
    } finally {
      await inbound.shutdown();
      await inbound.done;
      await functions.shutdown();
      await servedAmateur.server.shutdown();
      await servedSpecial.server.shutdown();
    }
  },
);
