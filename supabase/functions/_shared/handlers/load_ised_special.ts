// The ISED special callsign load, called by the inbound worker with the inbound worker secret,
// one action per POST: status, begin, rows (repeated), then finish or abandon. Each is one
// ised_special_load_* RPC; pg_cron's apply_license_loads swaps a finished load into
// ised_special_callsigns. A database error answers 500 with its message.

import { z } from "zod";
import { secretsMatch } from "../auth.ts";
import { type IsedSpecialDb } from "../types.ts";
import { type LoadIsedSpecialRequest, loadIsedSpecialRequestSchema } from "../ised_special.ts";
import { logError } from "../sentry.ts";

export interface LoadIsedSpecialDeps {
  /** LONGLINES_INBOUND_SECRET; undefined when unset. */
  secret: string | undefined;
  db: () => IsedSpecialDb;
}

function firstIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return fallback;
  }
  const path = issue.path.map((key) => String(key)).join(".");
  if (path === "") {
    return issue.message;
  }
  return `${path}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function run(request: LoadIsedSpecialRequest, db: IsedSpecialDb): Promise<unknown> {
  switch (request.action) {
    case "status":
      return await db.loadStatus();
    case "begin":
      return { load: await db.beginLoad(request.version) };
    case "rows":
      return { staged: await db.stageRows(request.load, request.rows) };
    case "finish":
      await db.finishLoad(request.load, request.rows);
      return { ok: true };
    case "abandon":
      await db.abandonLoad(request.load, request.error);
      return { ok: true };
  }
}

export async function handleLoadIsedSpecial(
  req: Request,
  deps: LoadIsedSpecialDeps,
): Promise<Response> {
  if (deps.secret === undefined || deps.secret === "") {
    logError("load-ised-special: missing environment variable LONGLINES_INBOUND_SECRET", undefined);
    return Response.json({ error: "inbound secret is not configured" }, { status: 500 });
  }
  let header = req.headers.get("x-inbound-secret");
  if (header === null) {
    header = "";
  }
  if (!await secretsMatch(header, deps.secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json({ error: "request body is not JSON" }, { status: 400 });
    }
    const message = errorMessage(error);
    logError(`load-ised-special: reading the request body failed: ${message}`, error);
    return Response.json({ error: message }, { status: 500 });
  }

  const envelope = loadIsedSpecialRequestSchema.safeParse(body);
  if (!envelope.success) {
    return Response.json({ error: firstIssue(envelope.error, "Bad request") }, { status: 400 });
  }

  try {
    const result = await run(envelope.data, deps.db());
    if (envelope.data.action !== "rows") {
      console.log(JSON.stringify({ action: envelope.data.action, result }));
    }
    return Response.json(result);
  } catch (error) {
    const message = errorMessage(error);
    logError(`load-ised-special ${envelope.data.action}: ${message}`, error);
    return Response.json({ error: message }, { status: 500 });
  }
}
