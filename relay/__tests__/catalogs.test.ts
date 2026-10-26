import { assertEquals, assertRejects } from "@std/assert";
import {
  FunctionCallError,
  TimeoutError,
  ValidationError,
} from "../../supabase/functions/_shared/errors.ts";
import type {
  LoadReferencesRequest,
  ProgramLoadStatus,
  ReferenceCatalogRow,
  ReferenceFinishState,
  ReferenceLoadStatus,
  ReferenceProgram,
} from "../../supabase/functions/_shared/reference_catalog.ts";
import {
  type CatalogImportLoop,
  type CatalogImportOptions,
  checkCatalogs,
  importCatalog,
  type ReferenceClient,
  referenceClient,
  RELOAD_AFTER_MS,
  RETRY_AFTER_MS,
  runCatalogImports,
  shouldLoad,
} from "../catalogs.ts";
import type { CatalogUrls } from "../config.ts";
import { startRelay } from "../relay.ts";

const NOW = new Date("2026-10-26T12:00:00Z");
const VERSION = "Mon, 26 Oct 2026 07:15:20 GMT";
const OLDER = "Mon, 19 Oct 2026 07:15:20 GMT";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(
      `../../supabase/functions/_shared/__tests__/fixtures/${name}`,
      import.meta.url,
    ),
  );
}

// Cut from the real files (supabase/functions/_shared/__tests__/reference_catalog.test.ts).
const FILES: Record<ReferenceProgram, string> = {
  pota: fixture("pota-parks.csv"),
  sota: fixture("sota-summits.csv"),
  wwff: fixture("wwff-directory.csv"),
};
const ROWS: Record<ReferenceProgram, number> = { pota: 22, sota: 16, wwff: 26 };

interface ServedRequest {
  method: string;
  program: string;
  userAgent: string | null;
}

interface CatalogServerOptions {
  /** Last-Modified per program; VERSION otherwise. */
  lastModified?: Partial<Record<ReferenceProgram, string>>;
  /** Last-Modified on the GET when it differs from the HEAD's (the file changed in between). */
  getLastModified?: Partial<Record<ReferenceProgram, string>>;
  /** Answer HEAD with this status. */
  headStatus?: Partial<Record<ReferenceProgram, number>>;
  /** Answer GET with this status. */
  getStatus?: Partial<Record<ReferenceProgram, number>>;
  /** Send this many characters of the file and then hold the connection open. */
  stallAfter?: Partial<Record<ReferenceProgram, number>>;
}

/** The three lists, served like the programs' sites do: HEAD with Last-Modified, GET the file. */
function serveCatalogs(options: CatalogServerOptions) {
  const requests: ServedRequest[] = [];
  function pick<T>(
    map: Partial<Record<ReferenceProgram, T>> | undefined,
    program: string,
  ) {
    if (map === undefined) {
      return undefined;
    }
    return map[program as ReferenceProgram];
  }
  function handler(req: Request): Response {
    const program = new URL(req.url).pathname.slice(1);
    requests.push({
      method: req.method,
      program,
      userAgent: req.headers.get("user-agent"),
    });
    const text = FILES[program as ReferenceProgram];
    if (text === undefined) {
      return new Response(null, { status: 404 });
    }
    let lastModified = pick(options.lastModified, program);
    if (lastModified === undefined) {
      lastModified = VERSION;
    }
    const headers: Record<string, string> = { "last-modified": lastModified };
    if (req.method === "HEAD") {
      let status = pick(options.headStatus, program);
      if (status === undefined) {
        status = 200;
      }
      return new Response(null, { status, headers });
    }
    const status = pick(options.getStatus, program);
    if (status !== undefined) {
      return new Response("unavailable", { status });
    }
    const changed = pick(options.getLastModified, program);
    if (changed !== undefined) {
      headers["last-modified"] = changed;
    }
    const stall = pick(options.stallAfter, program);
    if (stall !== undefined) {
      const head = new TextEncoder().encode(text.slice(0, stall));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head);
        },
      });
      return new Response(body, { headers });
    }
    return new Response(text, { headers });
  }
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    handler,
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  const urls: CatalogUrls = {
    pota: `${base}/pota`,
    sota: `${base}/sota`,
    wwff: `${base}/wwff`,
  };
  return { urls, requests, server };
}

function emptyStatus(): ReferenceLoadStatus {
  return {
    pota: { applied: null, newest: null },
    sota: { applied: null, newest: null },
    wwff: { applied: null, newest: null },
  };
}

interface FakeOptions {
  status?: ReferenceLoadStatus;
  failRows?: number;
  loseReplies?: number;
  finishState?: ReferenceFinishState;
}

/**
 * load-references in memory. Staging is keyed by reference, like the RPC, and rows answers the
 * load's total. failRows rejects before staging; loseReplies stages the batch and then rejects,
 * as when the reply times out.
 */
function fakeClient(options: FakeOptions) {
  const begun: { program: ReferenceProgram; version: string }[] = [];
  const batches: { load: number; rows: ReferenceCatalogRow[] }[] = [];
  const finished: { load: number; rows: number }[] = [];
  const abandoned: string[] = [];
  const staged = new Map<number, Set<string>>();
  let failures = 0;
  if (options.failRows !== undefined) {
    failures = options.failRows;
  }
  let lost = 0;
  if (options.loseReplies !== undefined) {
    lost = options.loseReplies;
  }
  let status = emptyStatus();
  if (options.status !== undefined) {
    status = options.status;
  }
  let finishState: ReferenceFinishState = "finished";
  if (options.finishState !== undefined) {
    finishState = options.finishState;
  }
  const client: ReferenceClient = {
    status: () => Promise.resolve(status),
    begin(program, version) {
      begun.push({ program, version });
      staged.set(40 + begun.length, new Set());
      return Promise.resolve(40 + begun.length);
    },
    rows(load, rows) {
      if (failures-- > 0) {
        return Promise.reject(new Error("HTTP 503"));
      }
      batches.push({ load, rows });
      const set = staged.get(load)!;
      for (const row of rows) {
        set.add(row.reference);
      }
      if (lost-- > 0) {
        return Promise.reject(new Error("signal timed out"));
      }
      return Promise.resolve(set.size);
    },
    finish(load, rows) {
      finished.push({ load, rows });
      return Promise.resolve(finishState);
    },
    abandon(_load, error) {
      abandoned.push(error);
      return Promise.resolve();
    },
  };
  return { client, begun, batches, finished, abandoned };
}

function ignoreLog(): void {}

function importOptions(
  overrides: Partial<CatalogImportOptions>,
): CatalogImportOptions {
  const options: CatalogImportOptions = {
    log: ignoreLog,
    signal: new AbortController().signal,
    fetchFn: fetch,
    now: () => NOW,
    retryDelaysMs: [0, 0],
  };
  return Object.assign(options, overrides);
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

/**
 * A program's loads. The applied load began `hoursAgo` and was applied an hour later (the
 * download and the wait for the hourly swap).
 */
function program(
  applied: { version: string; hoursAgo: number } | null,
  newest: { version: string; state: string; hoursAgo: number } | null,
): ProgramLoadStatus {
  const status: ProgramLoadStatus = { applied: null, newest: null };
  if (applied !== null) {
    status.applied = {
      version: applied.version,
      started_at: hoursAgo(applied.hoursAgo),
      applied_at: hoursAgo(applied.hoursAgo - 1),
      rows: 1,
    };
  }
  if (newest !== null) {
    status.newest = {
      id: 1,
      version: newest.version,
      state: newest.state as "staging",
      rows: 1,
      started_at: hoursAgo(newest.hoursAgo),
      finished_at: null,
    };
  }
  return status;
}

Deno.test("shouldLoad waits a week, takes only a newer file and backs off a failed load", function (): void {
  const week = RELOAD_AFTER_MS / 3_600_000;
  const retry = RETRY_AFTER_MS / 3_600_000;
  // Never loaded: load.
  assertEquals(shouldLoad(VERSION, program(null, null), NOW), true);
  // Begun a week ago and applied under a week ago, an older file: load, so the seventh daily
  // check after the load takes it (not the eighth); begun less than a week ago: wait.
  const applied = { version: OLDER, hoursAgo: week };
  const appliedLoad = { version: OLDER, state: "applied", hoursAgo: week };
  assertEquals(shouldLoad(VERSION, program(applied, appliedLoad), NOW), true);
  assertEquals(
    shouldLoad(
      VERSION,
      program({ version: OLDER, hoursAgo: week - 1 }, appliedLoad),
      NOW,
    ),
    false,
  );
  // The same file, or one that is not newer.
  assertEquals(
    shouldLoad(OLDER, program(applied, appliedLoad), NOW),
    false,
  );
  assertEquals(
    shouldLoad(
      "Sun, 18 Oct 2026 07:15:20 GMT",
      program(applied, appliedLoad),
      NOW,
    ),
    false,
  );
  // Versions that are not dates compare as text.
  assertEquals(
    shouldLoad('"b"', program({ version: '"a"', hoursAgo: week }, null), NOW),
    true,
  );
  assertEquals(
    shouldLoad('"a"', program({ version: '"a"', hoursAgo: week }, null), NOW),
    false,
  );
  // A refused or finished version is never loaded again; a newer file is.
  for (const state of ["refused", "finished", "applied"]) {
    assertEquals(
      shouldLoad(
        VERSION,
        program(applied, { version: VERSION, state, hoursAgo: 30 }),
        NOW,
      ),
      false,
      state,
    );
  }
  assertEquals(
    shouldLoad(
      VERSION,
      program(applied, { version: OLDER, state: "refused", hoursAgo: 30 }),
      NOW,
    ),
    true,
  );
  // A finished load waiting to apply goes first, whatever the file.
  assertEquals(
    shouldLoad(
      VERSION,
      program(applied, { version: OLDER, state: "finished", hoursAgo: 1 }),
      NOW,
    ),
    false,
  );
  // An unfinished load is retried after twelve hours, the same version included.
  for (const state of ["staging", "abandoned"]) {
    assertEquals(
      shouldLoad(
        VERSION,
        program(null, { version: VERSION, state, hoursAgo: retry - 1 }),
        NOW,
      ),
      false,
      state,
    );
    assertEquals(
      shouldLoad(
        VERSION,
        program(null, { version: VERSION, state, hoursAgo: retry }),
        NOW,
      ),
      true,
      state,
    );
  }
});

Deno.test("referenceClient sends one action per call and reads the reply", async function (): Promise<
  void
> {
  const sent: LoadReferencesRequest[] = [];
  const replies: unknown[] = [
    { status: emptyStatus() },
    { load: 9 },
    { staged: 2 },
    { state: "refused" },
    { ok: true },
  ];
  function post(body: LoadReferencesRequest): Promise<unknown> {
    sent.push(body);
    return Promise.resolve(replies.shift());
  }
  const client = referenceClient(post);
  assertEquals(await client.status(), emptyStatus());
  assertEquals(await client.begin("sota", VERSION), 9);
  assertEquals(await client.rows(9, []), 2);
  assertEquals(await client.finish(9, 2), "refused");
  await client.abandon(9, "boom");
  assertEquals(sent, [
    { action: "status" },
    { action: "begin", program: "sota", version: VERSION },
    { action: "rows", load: 9, rows: [] },
    { action: "finish", load: 9, rows: 2 },
    { action: "abandon", load: 9, error: "boom" },
  ]);
});

Deno.test("referenceClient refuses a reply that is not load-references' shape", async function (): Promise<
  void
> {
  function replying(reply: unknown): ReferenceClient {
    return referenceClient(() => Promise.resolve(reply));
  }
  await assertRejects(
    () => replying({}).status(),
    ValidationError,
    "referenceClient.status: load-references reply",
  );
  await assertRejects(
    () => replying({ load: "9" }).begin("pota", VERSION),
    ValidationError,
    "referenceClient.begin: load-references reply: load",
  );
  await assertRejects(
    () => replying({ staged: 2, extra: true }).rows(9, []),
    ValidationError,
    "referenceClient.rows: load-references reply",
  );
  await assertRejects(
    () => replying({ state: "applied" }).finish(9, 2),
    ValidationError,
    "referenceClient.finish: load-references reply: state",
  );
});

Deno.test("importCatalog stages a list in batches, retries a failed batch and finishes with the total", async function (): Promise<
  void
> {
  const served = serveCatalogs({});
  const fake = fakeClient({ failRows: 2 });
  try {
    const result = await importCatalog(
      "pota",
      served.urls.pota,
      VERSION,
      fake.client,
      importOptions({ batchSize: 10 }),
    );
    assertEquals(result, {
      load: 41,
      version: VERSION,
      state: "finished",
      staged: 22,
      skipped: 0,
    });
    assertEquals(fake.begun, [{ program: "pota", version: VERSION }]);
    assertEquals(fake.batches.map((b) => b.rows.length), [10, 10, 2]);
    assertEquals(fake.finished, [{ load: 41, rows: 22 }]);
    const first = fake.batches[0]!.rows[0]!;
    assertEquals([first.reference, first.name, first.grid], [
      "US-0001",
      "Acadia National Park",
      "FN54vh",
    ]);
    // The relay's User-Agent on the GET.
    assertEquals(served.requests.map((r) => r.method), ["GET"]);
    assertEquals(
      served.requests.every((r) => r.userAgent!.startsWith("LongLines/")),
      true,
    );
  } finally {
    await served.server.shutdown();
  }
});

Deno.test("importCatalog counts a batch retried after a lost reply once", async function (): Promise<
  void
> {
  const served = serveCatalogs({});
  const fake = fakeClient({ loseReplies: 1 });
  try {
    const result = await importCatalog(
      "sota",
      served.urls.sota,
      VERSION,
      fake.client,
      importOptions({ batchSize: 5, retryDelaysMs: [0] }),
    );
    assertEquals(fake.batches.length, 5); // the first batch went twice
    assertEquals([result.staged, result.state], [ROWS.sota, "finished"]);
    assertEquals(fake.finished, [{ load: 41, rows: ROWS.sota }]);
  } finally {
    await served.server.shutdown();
  }
});

Deno.test("importCatalog returns a refusal as the load's state", async function (): Promise<
  void
> {
  const served = serveCatalogs({});
  const fake = fakeClient({ finishState: "refused" });
  try {
    const result = await importCatalog(
      "wwff",
      served.urls.wwff,
      VERSION,
      fake.client,
      importOptions({}),
    );
    assertEquals([result.state, result.staged, result.skipped], [
      "refused",
      ROWS.wwff,
      1,
    ]);
    assertEquals(fake.abandoned, []);
  } finally {
    await served.server.shutdown();
  }
});

Deno.test("importCatalog gives up after the retries and abandons the load", async function (): Promise<
  void
> {
  const served = serveCatalogs({});
  const fake = fakeClient({ failRows: 3 });
  try {
    await assertRejects(
      () =>
        importCatalog(
          "pota",
          served.urls.pota,
          VERSION,
          fake.client,
          importOptions({}),
        ),
      Error,
      "HTTP 503",
    );
    assertEquals(fake.finished, []);
    assertEquals(fake.abandoned, ["HTTP 503"]);
  } finally {
    await served.server.shutdown();
  }
});

Deno.test("importCatalog abandons a load whose download fails, changes or stalls", async function (): Promise<
  void
> {
  const served = serveCatalogs({
    getStatus: { pota: 503 },
    getLastModified: { sota: "Tue, 27 Oct 2026 03:39:12 GMT" },
    stallAfter: { wwff: 600 },
  });
  try {
    const failed = fakeClient({});
    const error = await assertRejects(
      () =>
        importCatalog(
          "pota",
          served.urls.pota,
          VERSION,
          failed.client,
          importOptions({}),
        ),
      FunctionCallError,
      "/pota: HTTP 503",
    );
    assertEquals(error.status, 503);
    assertEquals(failed.abandoned.length, 1);

    const changed = fakeClient({});
    await assertRejects(
      () =>
        importCatalog(
          "sota",
          served.urls.sota,
          VERSION,
          changed.client,
          importOptions({}),
        ),
      ValidationError,
      `Last-Modified Tue, 27 Oct 2026 03:39:12 GMT, but HEAD said ${VERSION}`,
    );
    assertEquals([changed.batches, changed.abandoned.length], [[], 1]);

    const stalled = fakeClient({});
    await assertRejects(
      () =>
        importCatalog(
          "wwff",
          served.urls.wwff,
          VERSION,
          stalled.client,
          importOptions({ readTimeoutMs: 50 }),
        ),
      TimeoutError,
      "wwff_directory.csv: no data for 0.05 s",
    );
    assertEquals(stalled.abandoned, ["wwff_directory.csv: no data for 0.05 s"]);
  } finally {
    await served.server.shutdown();
  }
});

/** A fetch that never answers; it rejects with the abort reason, as fetch does. */
function never(_input: string | URL | Request, init: RequestInit | undefined): Promise<Response> {
  const signal = init!.signal!;
  return new Promise(function wait(_resolve, reject): void {
    function onAbort(): void {
      const reason: unknown = signal.reason;
      if (reason instanceof Error) {
        reject(reason);
      } else {
        reject(new Error(String(reason)));
      }
    }
    signal.addEventListener("abort", onAbort);
  });
}

Deno.test("importCatalog stops when the relay shuts down or the headers never come", async function (): Promise<
  void
> {
  const served = serveCatalogs({});
  try {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeClient({});
    await assertRejects(() =>
      importCatalog(
        "pota",
        served.urls.pota,
        VERSION,
        fake.client,
        importOptions({ signal: controller.signal }),
      )
    );
    assertEquals(fake.abandoned.length, 1);

    // A server that never answers: only the wait for headers is bounded.
    const silent = fakeClient({});
    await assertRejects(
      () =>
        importCatalog(
          "pota",
          served.urls.pota,
          VERSION,
          silent.client,
          importOptions({ fetchFn: never, headerTimeoutMs: 20 }),
        ),
      TimeoutError,
      "no response within 20 ms",
    );
  } finally {
    await served.server.shutdown();
  }
});

Deno.test("importCatalog logs a failed abandon and throws the load's own error", async function (): Promise<
  void
> {
  const served = serveCatalogs({ getStatus: { pota: 500 } });
  const fake = fakeClient({});
  const logs: string[] = [];
  const client: ReferenceClient = {
    status: fake.client.status,
    begin: fake.client.begin,
    rows: fake.client.rows,
    finish: fake.client.finish,
    abandon: () => Promise.reject(new Error("HTTP 502")),
  };
  try {
    await assertRejects(
      () =>
        importCatalog(
          "pota",
          served.urls.pota,
          VERSION,
          client,
          importOptions({ log: (m) => logs.push(m) }),
        ),
      FunctionCallError,
      "HTTP 500",
    );
    assertEquals(logs, ["abandon failed: HTTP 502"]);
  } finally {
    await served.server.shutdown();
  }
});

function loop(
  urls: CatalogUrls,
  client: ReferenceClient,
  logs: string[],
  overrides: Partial<CatalogImportLoop>,
): CatalogImportLoop {
  const options: CatalogImportLoop = {
    urls,
    client,
    log: (m) => logs.push(m),
    signal: new AbortController().signal,
    fetchFn: fetch,
    now: () => NOW,
    retryDelaysMs: [0],
  };
  return Object.assign(options, overrides);
}

Deno.test("checkCatalogs loads each due list in turn, one download at a time", async function (): Promise<
  void
> {
  const served = serveCatalogs({ headStatus: { sota: 500 } });
  const week = RELOAD_AFTER_MS / 3_600_000;
  const status = emptyStatus();
  // WWFF's list was applied yesterday: not due.
  status.wwff = program({ version: OLDER, hoursAgo: 24 }, {
    version: OLDER,
    state: "applied",
    hoursAgo: 25,
  });
  status.pota = program({ version: OLDER, hoursAgo: week }, null);
  const fake = fakeClient({ status });
  const logs: string[] = [];
  try {
    const loads = await checkCatalogs(loop(served.urls, fake.client, logs, {}));
    assertEquals(loads.map((l) => [l.load, l.state, l.staged]), [[
      41,
      "finished",
      ROWS.pota,
    ]]);
    // HEAD each list; GET only the due one. SOTA's failed HEAD did not stop WWFF's.
    assertEquals(served.requests.map((r) => `${r.method} ${r.program}`), [
      "HEAD pota",
      "GET pota",
      "HEAD sota",
      "HEAD wwff",
    ]);
    assertEquals(
      served.requests.every((r) => r.userAgent!.startsWith("LongLines/")),
      true,
    );
    assertEquals(logs, [
      `pota: loading ${served.urls.pota} (${VERSION})`,
      `pota: ${ROWS.pota} staged, 0 skipped, finished`,
      "sota: load failed: HEAD " + served.urls.sota + ": HTTP 500",
    ]);
  } finally {
    await served.server.shutdown();
  }
});

Deno.test("checkCatalogs logs a refusal and a file without Last-Modified", async function (): Promise<
  void
> {
  const served = serveCatalogs({ lastModified: { sota: "" } });
  const fake = fakeClient({ finishState: "refused" });
  const logs: string[] = [];
  try {
    const controller = new AbortController();
    const loads = await checkCatalogs(loop(served.urls, fake.client, logs, {
      signal: controller.signal,
    }));
    assertEquals(loads.map((l) => l.state), ["refused", "refused"]);
    assertEquals(logs.filter((m) => m.startsWith("sota")), [
      `sota: load failed: HEAD ${served.urls.sota}: no Last-Modified`,
    ]);
    assertEquals(
      logs.includes(
        "wwff: refused as incomplete or below the floor; the old list stays",
      ),
      true,
    );
    // Aborted: no program is checked.
    controller.abort();
    assertEquals(
      await checkCatalogs(
        loop(served.urls, fake.client, [], { signal: controller.signal }),
      ),
      [],
    );
  } finally {
    await served.server.shutdown();
  }
});

// Rejects with whatever it is given, so a test can reject with a non-Error.
async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

Deno.test("runCatalogImports logs a failed check and stops on abort", async function (): Promise<
  void
> {
  const controller = new AbortController();
  const logs: string[] = [];
  const fake = fakeClient({});
  const client: ReferenceClient = {
    status: () => Promise.reject(new Error("HTTP 503")),
    begin: fake.client.begin,
    rows: fake.client.rows,
    finish: fake.client.finish,
    abandon: fake.client.abandon,
  };
  function logAndStop(m: string): void {
    logs.push(m);
    controller.abort();
  }
  const urls = { pota: "http://127.0.0.1:9/pota", sota: "", wwff: "" };
  await runCatalogImports(loop(urls, client, logs, {
    signal: controller.signal,
    log: logAndStop,
    firstCheckMs: 0,
    checkMs: 60_000,
  }));
  assertEquals(logs, ["check failed: HTTP 503"]);
});

Deno.test("runCatalogImports throws a failed check that is not an Error", async function (): Promise<
  void
> {
  const fake = fakeClient({});
  const client: ReferenceClient = {
    status: fake.client.status,
    begin: fake.client.begin,
    rows: fake.client.rows,
    finish: fake.client.finish,
    abandon: fake.client.abandon,
  };
  const logs: string[] = [];
  await assertRejects(() =>
    runCatalogImports(
      loop(
        { pota: "http://127.0.0.1:9/pota", sota: "", wwff: "" },
        client,
        logs,
        {
          firstCheckMs: 0,
          checkMs: 60_000,
          fetchFn: () => rejectWith("connection refused"),
        },
      ),
    )
  );
  assertEquals(logs, []);
});

Deno.test("the relay loads the reference lists through load-references with its secret", async function (): Promise<
  void
> {
  const served = serveCatalogs({});
  const requests: { secret: string | null; body: LoadReferencesRequest }[] = [];
  const totals = new Map<number, number>();
  let nextLoad = 3;
  async function handler(req: Request): Promise<Response> {
    // The Health page heartbeat (relay/status.ts) posts here too.
    if (new URL(req.url).pathname.endsWith("/relay-status")) {
      return Response.json({ ok: true });
    }
    const body = await req.json() as LoadReferencesRequest;
    requests.push({ secret: req.headers.get("x-relay-secret"), body });
    switch (body.action) {
      case "status":
        return Response.json({ status: emptyStatus() });
      case "begin":
        totals.set(nextLoad, 0);
        return Response.json({ load: nextLoad++ });
      case "rows": {
        const total = totals.get(body.load)! + body.rows.length;
        totals.set(body.load, total);
        return Response.json({ staged: total });
      }
      case "finish":
        return Response.json({ state: "finished" });
      case "abandon":
        return Response.json({ ok: true });
    }
  }
  const functions = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, handler);
  const logs: string[] = [];
  const relay = startRelay(
    {
      functionsUrl: `http://127.0.0.1:${functions.addr.port}/functions/v1`,
      relaySecret: "s",
      loginCall: "N0CALL",
      healthPort: 0,
      licenseZipUrl: null,
      catalogUrls: served.urls,
    },
    [],
    {
      hostname: "127.0.0.1",
      log: (m) => logs.push(m),
      catalogs: {
        firstCheckMs: 0,
        now: () => NOW,
        fetchFn: fetch,
        batchSize: 10,
      },
    },
  );
  try {
    const deadline = Date.now() + 5_000;
    // The log follows the finish response, so waiting on the request alone races it. Wait for
    // that line, not any WWFF line: "wwff: loading ..." comes before the download.
    while (
      !logs.includes(`[catalogs] wwff: ${ROWS.wwff} staged, 1 skipped, finished`) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(requests.every((r) => r.secret === "s"), true);
    assertEquals(
      requests.map((r) => r.body.action).join(" "),
      "status begin rows rows rows finish begin rows rows finish begin rows rows rows finish",
    );
    assertEquals(
      requests.filter((r) => r.body.action === "finish").map((r) => r.body),
      [
        { action: "finish", load: 3, rows: ROWS.pota },
        { action: "finish", load: 4, rows: ROWS.sota },
        { action: "finish", load: 5, rows: ROWS.wwff },
      ],
    );
    assertEquals(
      logs.includes(
        `[catalogs] wwff: ${ROWS.wwff} staged, 1 skipped, finished`,
      ),
      true,
    );
  } finally {
    await relay.shutdown();
    await relay.done;
    await functions.shutdown();
    await served.server.shutdown();
  }
});
