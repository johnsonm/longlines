import { assertEquals, assertRejects } from "@std/assert";
import type {
  LicenseLoad,
  LoadLicensesRequest,
  UlsCounts,
  UlsKind,
  UlsRow,
} from "../../supabase/functions/_shared/uls.ts";
import {
  checkLicenses,
  importLicenses,
  type LicenseClient,
  licenseClient,
  runLicenseImports,
  shouldImport,
} from "../licenses.ts";
import { startRelay } from "../relay.ts";
import { openHttpZip } from "../zip.ts";
import { buildZip, serveZip } from "./zip_server.ts";

const VERSION = "Sun, 11 Oct 2026 13:18:48 GMT";
const NOW = new Date("2026-10-12T12:00:00Z");
const MIN = { HD: 1, EN: 1, AM: 1 };

// Twelve synthetic licensees (made-up calls), one EN contact row that is not
// the licensee, one HD record whose field breaks across lines, and junk.
const calls = Array.from({ length: 12 }, (_, i) => `KK4${String.fromCharCode(65 + i)}XS`);
const HD = [
  ...calls.map((c, i) => `HD|${i + 1}|||${c}|A|HA|01/02/2020|01/02/2030|||`),
  "HD|13|||W4BRK|E|HA|01/01/2000|01/01/2010|line",
  "break|||",
  "HD|x|||BAD|A|",
].join("\r\n");
const EN = [
  ...calls.map((c, i) => `EN|${i + 1}|||${c}|L||Doe, Jo|Jo||Doe||||||City|NC|27601||||1|I||`),
  "EN|1|||KK4AXS|CL||Someone Else||||||||||||||||",
].join("\r\n") + "\r\n";
const AM = calls.map((c, i) => `AM|${i + 1}|||${c}|${"EGT"[i % 3]}|`).join("\r\n") + "\r\n";
const ZIP = buildZip([
  { name: "counts", text: "", stored: true },
  { name: "AM.dat", text: AM },
  { name: "EN.dat", text: EN },
  { name: "HD.dat", text: HD },
]);

/**
 * load-licenses in memory. Staging is keyed by usi, like the RPC, and rows
 * answers the file's total. failRows rejects before staging; loseReplies
 * stages the batch and then rejects, as when the reply times out.
 */
function fakeClient(
  options: { latest?: LicenseLoad | null; failRows?: number; loseReplies?: number } = {},
) {
  const batches: { load: number; kind: UlsKind; rows: UlsRow[] }[] = [];
  const finished: UlsCounts[] = [];
  const abandoned: string[] = [];
  const staged = { HD: new Set<number>(), EN: new Set<number>(), AM: new Set<number>() };
  let failures = options.failRows ?? 0;
  let lost = options.loseReplies ?? 0;
  const client: LicenseClient = {
    status: () => Promise.resolve(options.latest ?? null),
    begin: () => Promise.resolve(41),
    rows(load, kind, rows) {
      if (failures-- > 0) return Promise.reject(new Error("HTTP 503"));
      batches.push({ load, kind, rows });
      for (const row of rows) staged[kind].add(row.usi);
      if (lost-- > 0) return Promise.reject(new Error("signal timed out"));
      return Promise.resolve(staged[kind].size);
    },
    finish(_load, counts) {
      finished.push(counts);
      return Promise.resolve();
    },
    abandon(_load, error) {
      abandoned.push(error);
      return Promise.resolve();
    },
  };
  return { client, batches, finished, abandoned };
}

const load = (status: LicenseLoad["status"], version = VERSION, hoursAgo = 1): LicenseLoad => ({
  id: 1,
  version,
  status,
  started_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
});

Deno.test("shouldImport loads a new file and retries an unfinished one after twelve hours", () => {
  assertEquals(shouldImport(VERSION, null, NOW), true);
  assertEquals(shouldImport(VERSION, load("applied"), NOW), false);
  assertEquals(shouldImport(VERSION, load("ready"), NOW), false);
  assertEquals(shouldImport(VERSION, load("applied", "older"), NOW), true);
  assertEquals(shouldImport(VERSION, load("ready", "older"), NOW), true);
  assertEquals(shouldImport(VERSION, load("loading", VERSION, 11), NOW), false);
  assertEquals(shouldImport(VERSION, load("failed", "older", 11), NOW), false);
  assertEquals(shouldImport(VERSION, load("loading", VERSION, 12), NOW), true);
  assertEquals(shouldImport(VERSION, load("failed", VERSION, 13), NOW), true);
});

Deno.test("licenseClient sends one action per call and reads the reply", async () => {
  const sent: LoadLicensesRequest[] = [];
  const replies: unknown[] = [{ load: null }, { load: 9 }, { staged: 2 }, { ok: true }, {
    ok: true,
  }];
  const client = licenseClient((body) => {
    sent.push(body);
    return Promise.resolve(replies.shift());
  });
  assertEquals(await client.status(), null);
  assertEquals(await client.begin("v"), 9);
  const rows = [{ usi: 1, operator_class: "General" }];
  assertEquals(await client.rows(9, "AM", rows), 2);
  await client.finish(9, { HD: 1, EN: 1, AM: 2 });
  await client.abandon(9, "boom");
  assertEquals(sent, [
    { action: "status" },
    { action: "begin", version: "v" },
    { action: "rows", load: 9, kind: "AM", rows },
    { action: "finish", load: 9, counts: { HD: 1, EN: 1, AM: 2 } },
    { action: "abandon", load: 9, error: "boom" },
  ]);
});

Deno.test("importLicenses stages HD, EN and AM in batches and finishes with the counts", async () => {
  const { url, server } = serveZip(await ZIP);
  const { client, batches, finished } = fakeClient({ failRows: 2 });
  const logs: string[] = [];
  try {
    const signal = new AbortController().signal;
    const staged = await importLicenses(await openHttpZip(url, signal), client, {
      log: (m) => logs.push(m),
      signal,
      batchSize: 5,
      minRecords: MIN,
      retryDelaysMs: [0, 0],
    });
    assertEquals(staged, { HD: 13, EN: 12, AM: 12 });
    assertEquals(finished, [staged]);
    assertEquals(batches.map((b) => `${b.kind}${b.rows.length}`), [
      "HD5",
      "HD5",
      "HD3",
      "EN5",
      "EN5",
      "EN2",
      "AM5",
      "AM5",
      "AM2",
    ]);
    assertEquals(batches.every((b) => b.load === 41), true);
    const hd = batches.flatMap((b) => b.kind === "HD" ? b.rows : []);
    assertEquals(hd.at(-1), {
      usi: 13,
      callsign: "W4BRK",
      status: "Expired",
      granted_on: "2000-01-01",
      expires_on: "2010-01-01",
    });
    const en = batches.find((b) => b.kind === "EN")!.rows[0];
    assertEquals(en, { usi: 1, name: "Jo Doe", first_name: "Jo", last_name: "Doe", state: "NC" });
    assertEquals(logs, [
      "HD.dat: 13 staged, 1 skipped",
      "EN.dat: 12 staged, 1 skipped",
      "AM.dat: 12 staged, 0 skipped",
    ]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("importLicenses counts a batch retried after a lost reply once", async () => {
  const { url, server } = serveZip(await ZIP);
  const { client, batches, finished } = fakeClient({ loseReplies: 1 });
  try {
    const signal = new AbortController().signal;
    const staged = await importLicenses(await openHttpZip(url, signal), client, {
      log: () => {},
      signal,
      batchSize: 5,
      minRecords: MIN,
      retryDelaysMs: [0],
    });
    assertEquals(batches.length, 10); // the first batch went twice
    assertEquals(staged, { HD: 13, EN: 12, AM: 12 });
    assertEquals(finished, [staged]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("importLicenses gives up after the retries and abandons the load", async () => {
  const { url, server } = serveZip(await ZIP);
  const { client, finished, abandoned } = fakeClient({ failRows: 3 });
  try {
    const signal = new AbortController().signal;
    await assertRejects(
      async () =>
        await importLicenses(await openHttpZip(url, signal), client, {
          log: () => {},
          signal,
          minRecords: MIN,
          retryDelaysMs: [0, 0],
        }),
      Error,
      "HTTP 503",
    );
    assertEquals(finished, []);
    assertEquals(abandoned, ["HTTP 503"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("importLicenses refuses a short file or a zip without the three files", async () => {
  const { url, server } = serveZip(await ZIP);
  const partial = serveZip(await buildZip([{ name: "HD.dat", text: HD }]));
  try {
    const signal = new AbortController().signal;
    const short = fakeClient();
    await assertRejects(
      async () =>
        await importLicenses(await openHttpZip(url, signal), short.client, {
          log: () => {},
          signal,
          minRecords: { HD: 14, EN: 1, AM: 1 },
        }),
      Error,
      "HD.dat has 13 records, expected at least 14",
    );
    assertEquals(short.finished, []);
    assertEquals(short.abandoned, ["HD.dat has 13 records, expected at least 14"]);
    await assertRejects(
      async () =>
        await importLicenses(await openHttpZip(partial.url, signal), fakeClient().client, {
          log: () => {},
          signal,
        }),
      Error,
      "EN.dat is not in the zip",
    );
  } finally {
    await server.shutdown();
    await partial.server.shutdown();
  }
});

Deno.test("importLicenses stops when the download stalls or the relay shuts down", async () => {
  const zip = await ZIP;
  const stalled = serveZip(zip, { stallAfter: 10 });
  const { url, server } = serveZip(zip);
  try {
    const signal = new AbortController().signal;
    await assertRejects(
      async () =>
        await importLicenses(await openHttpZip(stalled.url, signal), fakeClient().client, {
          log: () => {},
          signal,
          minRecords: MIN,
          readTimeoutMs: 50,
        }),
      Error,
      "no data for 0.05 s",
    );
    const controller = new AbortController();
    const remote = await openHttpZip(url, controller.signal);
    controller.abort();
    await assertRejects(
      () =>
        importLicenses(remote, fakeClient().client, { log: () => {}, signal: controller.signal }),
    );
  } finally {
    await stalled.server.shutdown();
    await server.shutdown();
  }
});

Deno.test("checkLicenses skips a file that is already loaded", async () => {
  const { url, server, requests } = serveZip(await ZIP);
  try {
    const { client, batches } = fakeClient({ latest: load("applied") });
    const staged = await checkLicenses({
      zipUrl: url,
      client,
      signal: new AbortController().signal,
      log: () => {},
      now: () => NOW,
    });
    assertEquals(staged, null);
    assertEquals(batches, []);
    assertEquals(requests.map((r) => r.method), ["HEAD"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("runLicenseImports logs a failed check and stops on abort", async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  const done = runLicenseImports({
    zipUrl: "http://127.0.0.1:9/l_amat",
    client: fakeClient().client,
    signal: controller.signal,
    log: (m) => {
      logs.push(m);
      controller.abort();
    },
    firstCheckMs: 0,
    checkMs: 60_000,
    fetchFn: () => Promise.reject(new Error("connection refused")),
  });
  await done;
  assertEquals(logs, ["load failed: connection refused"]);
});

Deno.test("the relay loads licenses through load-licenses with its secret", async () => {
  const { url, server } = serveZip(await ZIP);
  const requests: { secret: string | null; body: LoadLicensesRequest }[] = [];
  const totals = { HD: 0, EN: 0, AM: 0 };
  const functions = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      // The Health page heartbeat (relay/status.ts) posts here too.
      if (new URL(req.url).pathname.endsWith("/relay-status")) return Response.json({ ok: true });
      const body = await req.json() as LoadLicensesRequest;
      requests.push({ secret: req.headers.get("x-relay-secret"), body });
      switch (body.action) {
        case "status":
          return Response.json({ load: null });
        case "begin":
          return Response.json({ load: 3 });
        case "rows":
          return Response.json({ staged: totals[body.kind] += body.rows.length });
        case "finish":
        case "abandon":
          return Response.json({ ok: true });
      }
    },
  );
  const logs: string[] = [];
  const relay = startRelay(
    {
      functionsUrl: `http://127.0.0.1:${functions.addr.port}/functions/v1`,
      relaySecret: "s",
      loginCall: "N0CALL",
      healthPort: 0,
      licenseZipUrl: url,
    },
    [],
    {
      hostname: "127.0.0.1",
      log: (m) => logs.push(m),
      licenses: { firstCheckMs: 0, minRecords: MIN },
    },
  );
  try {
    const deadline = Date.now() + 5_000;
    // The log follows the finish response, so waiting on the request alone races it.
    while (!logs.some((m) => m.startsWith("[licenses] load finished")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(requests.map((r) => r.body.action), [
      "status",
      "begin",
      "rows",
      "rows",
      "rows",
      "finish",
    ]);
    assertEquals(requests.every((r) => r.secret === "s"), true);
    assertEquals(requests.at(-1)?.body, {
      action: "finish",
      load: 3,
      counts: { HD: 13, EN: 12, AM: 12 },
    });
    assertEquals(logs.some((m) => m.startsWith("[licenses] load finished")), true);
  } finally {
    await relay.shutdown();
    await relay.done;
    await functions.shutdown();
    await server.shutdown();
  }
});
