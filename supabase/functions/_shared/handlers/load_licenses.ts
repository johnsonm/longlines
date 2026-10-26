// The FCC license load, called by the relay (relay/licenses.ts) with the relay
// secret, one action per POST: status, begin, rows (repeated), then finish or
// abandon. Each is
// one fcc_license_load_* RPC; pg_cron's apply_license_loads swaps a finished
// load into callsign_licenses. A database error answers 500 with its message.

import { z } from "zod";
import { secretsMatch } from "../auth.ts";
import { type JsonObject, jsonObjectSchema, type LicenseDb } from "../types.ts";
import {
  type AmRow,
  type EnRow,
  type HdRow,
  type LoadLicensesRequest,
  MAX_ROWS_PER_REQUEST,
  ULS_KINDS,
  type UlsCounts,
  type UlsKind,
  type UlsRow,
} from "../uls.ts";

export interface LoadLicensesDeps {
  /** LONGLINES_RELAY_SECRET; undefined when unset. */
  secret: string | undefined;
  db: () => LicenseDb;
}

/** A load id or a row count: a non-negative safe integer, `message` for anything else. */
function countSchema(message: string): z.ZodType<number> {
  return z.number({ error: message }).int({ error: message }).min(0, { error: message });
}

const nullableText = z.string().nullable();

// The staging rows our relay builds (parseUlsRecord in uls.ts): strict, one schema per file.
// fcc_license_load_rows reads them with jsonb_to_recordset.
const hdRowSchema: z.ZodType<HdRow> = z.strictObject({
  usi: z.number(),
  callsign: z.string(),
  status: nullableText,
  granted_on: nullableText,
  expires_on: nullableText,
});
const enRowSchema: z.ZodType<EnRow> = z.strictObject({
  usi: z.number(),
  name: nullableText,
  first_name: nullableText,
  last_name: nullableText,
  state: nullableText,
});
const amRowSchema: z.ZodType<AmRow> = z.strictObject({
  usi: z.number(),
  operator_class: nullableText,
});
const ROWS_SCHEMAS: Readonly<Record<UlsKind, z.ZodType<UlsRow[]>>> = {
  HD: z.array(hdRowSchema),
  EN: z.array(enRowSchema),
  AM: z.array(amRowSchema),
};

const ROWS_LOAD_MESSAGE = "rows needs a load and an HD, EN or AM kind";
const ROWS_COUNT_MESSAGE = `rows needs 1 to ${String(MAX_ROWS_PER_REQUEST)} rows`;
const FINISH_MESSAGE = "finish needs a load and a count per kind";
const ABANDON_MESSAGE = "abandon needs a load and an error";

/** The rows action before its rows are checked against the kind's schema. */
interface RowsEnvelope {
  action: "rows";
  load: number;
  kind: UlsKind;
  rows: JsonObject[];
}

// Our relay's requests (licenseClient in relay/licenses.ts): strict, one schema per action. Each
// part's message is the one the handler answers.
const statusRequestSchema = z.strictObject({ action: z.literal("status") });
const beginRequestSchema = z.strictObject({
  action: z.literal("begin"),
  version: z.string({ error: "begin needs a version" })
    .max(100, { error: "begin needs a version" })
    .refine((version) => version.trim() !== "", { error: "begin needs a version" }),
});
// Not annotated: a member of the discriminated union below must keep its literal action.
const rowsRequestSchema = z.strictObject({
  action: z.literal("rows"),
  load: countSchema(ROWS_LOAD_MESSAGE),
  kind: z.enum(ULS_KINDS, { error: ROWS_LOAD_MESSAGE }),
  // Each row is checked against its kind's schema once the kind is known (rowsRequest).
  rows: z.array(jsonObjectSchema, { error: ROWS_COUNT_MESSAGE })
    .min(1, { error: ROWS_COUNT_MESSAGE })
    .max(MAX_ROWS_PER_REQUEST, { error: ROWS_COUNT_MESSAGE }),
});
const countsSchema: z.ZodType<UlsCounts> = z.strictObject({
  HD: countSchema(FINISH_MESSAGE),
  EN: countSchema(FINISH_MESSAGE),
  AM: countSchema(FINISH_MESSAGE),
}, { error: FINISH_MESSAGE });
const finishRequestSchema = z.strictObject({
  action: z.literal("finish"),
  load: countSchema(FINISH_MESSAGE),
  counts: countsSchema,
});
const abandonRequestSchema = z.strictObject({
  action: z.literal("abandon"),
  load: countSchema(ABANDON_MESSAGE),
  // Kept to the first 1,000 characters, as stored.
  error: z.string({ error: ABANDON_MESSAGE }).transform((error) => error.slice(0, 1000)),
});

/** A request as the envelope schema reads it: every action but rows is final. */
type LoadEnvelope = Exclude<LoadLicensesRequest, { action: "rows" }> | RowsEnvelope;

const loadEnvelopeSchema: z.ZodType<LoadEnvelope> = z.discriminatedUnion("action", [
  statusRequestSchema,
  beginRequestSchema,
  rowsRequestSchema,
  finishRequestSchema,
  abandonRequestSchema,
], { error: "action must be status, begin, rows, finish or abandon" });

/** The message of a ZodError's first issue: the one the hand-written checks reported. */
function firstIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return fallback;
  }
  return issue.message;
}

/** The rows request with each row checked against its kind, or a message. */
function rowsRequest(envelope: RowsEnvelope): LoadLicensesRequest | string {
  const result = ROWS_SCHEMAS[envelope.kind].safeParse(envelope.rows);
  if (!result.success) {
    return `every row must be an ${envelope.kind} row: ${firstIssue(result.error, "malformed")}`;
  }
  return { action: "rows", load: envelope.load, kind: envelope.kind, rows: result.data };
}

/** The request, or a message saying what is wrong with it. */
export function parseLoadRequest(body: unknown): LoadLicensesRequest | string {
  if (!jsonObjectSchema.safeParse(body).success) {
    return "body must be a JSON object";
  }
  const result = loadEnvelopeSchema.safeParse(body);
  if (!result.success) {
    return firstIssue(result.error, "body is not a load-licenses request");
  }
  const request = result.data;
  if (request.action === "rows") {
    return rowsRequest(request);
  }
  return request;
}

async function run(request: LoadLicensesRequest, db: LicenseDb): Promise<unknown> {
  switch (request.action) {
    case "status":
      return { load: await db.loadStatus() };
    case "begin":
      return { load: await db.beginLoad(request.version) };
    case "rows":
      return { staged: await db.stageRows(request.load, request.kind, request.rows) };
    case "finish":
      await db.finishLoad(request.load, request.counts);
      return { ok: true };
    case "abandon":
      await db.abandonLoad(request.load, request.error);
      return { ok: true };
  }
}

export async function handleLoadLicenses(req: Request, deps: LoadLicensesDeps): Promise<Response> {
  if (deps.secret === undefined || deps.secret === "") {
    console.error("load-licenses: missing environment variable LONGLINES_RELAY_SECRET");
    return Response.json({ error: "relay secret is not configured" }, { status: 500 });
  }
  let header = req.headers.get("x-relay-secret");
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
    // Bad JSON is the relay's fault; anything else (a broken stream) is ours.
    if (error instanceof SyntaxError) {
      return Response.json({ error: "request body is not JSON" }, { status: 400 });
    }
    const message = errorMessage(error);
    console.error(`load-licenses: reading the request body failed: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
  const request = parseLoadRequest(body);
  if (typeof request === "string") {
    return Response.json({ error: request }, { status: 400 });
  }

  try {
    const result = await run(request, deps.db());
    if (request.action !== "rows") {
      console.log(JSON.stringify({ action: request.action, result }));
    }
    return Response.json(result);
  } catch (err) {
    // The boundary: a failed RPC (FunctionCallError), a result of the wrong shape
    // (ValidationError) or anything else answers 500 with its message.
    const message = errorMessage(err);
    console.error(`load-licenses ${request.action}: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
