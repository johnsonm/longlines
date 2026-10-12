// The FCC license load, called by the relay (relay/licenses.ts) with the relay
// secret, one action per POST: status, begin, rows (repeated), finish. Each is
// one fcc_license_load_* RPC; pg_cron's apply_license_loads swaps a finished
// load into callsign_licenses. A database error answers 500 with its message.

import { secretsMatch } from "../auth.ts";
import type { LicenseDb } from "../types.ts";
import {
  type LoadLicensesRequest,
  MAX_ROWS_PER_REQUEST,
  ULS_KINDS,
  type UlsKind,
  type UlsRow,
} from "../uls.ts";

export interface LoadLicensesDeps {
  /** LONGLINES_RELAY_SECRET; undefined when unset. */
  secret: string | undefined;
  db: () => LicenseDb;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isKind = (v: unknown): v is UlsKind => ULS_KINDS.includes(v as UlsKind);

/** The request, or a message saying what is wrong with it. */
export function parseLoadRequest(body: unknown): LoadLicensesRequest | string {
  if (!isObject(body)) return "body must be a JSON object";
  switch (body.action) {
    case "status":
      return { action: "status" };
    case "begin":
      return typeof body.version === "string" && body.version.trim() !== "" &&
          body.version.length <= 100
        ? { action: "begin", version: body.version }
        : "begin needs a version";
    case "rows": {
      const { load, kind, rows } = body;
      if (!isCount(load) || !isKind(kind)) return "rows needs a load and an HD, EN or AM kind";
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS_PER_REQUEST) {
        return `rows needs 1 to ${MAX_ROWS_PER_REQUEST} rows`;
      }
      if (!rows.every(isObject)) return "every row must be an object";
      // Field types are checked by the RPC's jsonb_to_recordset, which also reads
      // only the columns it names, so any other key in a row is dropped.
      return { action: "rows", load, kind, rows: rows as unknown as UlsRow[] };
    }
    case "finish": {
      const { load, counts } = body;
      if (!isCount(load) || !isObject(counts) || !ULS_KINDS.every((k) => isCount(counts[k]))) {
        return "finish needs a load and a count per kind";
      }
      return {
        action: "finish",
        load,
        counts: { HD: counts.HD as number, EN: counts.EN as number, AM: counts.AM as number },
      };
    }
    default:
      return "action must be status, begin, rows or finish";
  }
}

async function run(request: LoadLicensesRequest, db: LicenseDb): Promise<unknown> {
  switch (request.action) {
    case "status":
      return { load: await db.loadStatus() };
    case "begin":
      return { load: await db.beginLoad(request.version) };
    case "rows":
      return { inserted: await db.stageRows(request.load, request.kind, request.rows) };
    case "finish":
      await db.finishLoad(request.load, request.counts);
      return { ok: true };
  }
}

export async function handleLoadLicenses(req: Request, deps: LoadLicensesDeps): Promise<Response> {
  if (!deps.secret) {
    console.error("load-licenses: missing environment variable LONGLINES_RELAY_SECRET");
    return Response.json({ error: "relay secret is not configured" }, { status: 500 });
  }
  if (!await secretsMatch(req.headers.get("x-relay-secret") ?? "", deps.secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (req.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body is not JSON" }, { status: 400 });
  }
  const request = parseLoadRequest(body);
  if (typeof request === "string") return Response.json({ error: request }, { status: 400 });

  try {
    const result = await run(request, deps.db());
    if (request.action !== "rows") console.log(JSON.stringify({ action: request.action, result }));
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`load-licenses ${request.action}: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
