// The reference list load, called by the relay (relay/catalogs.ts) with the relay secret, one
// action per POST: status, begin, rows (repeated), then finish or abandon. Each is one RPC of
// 20261026000100; pg_cron's apply_reference_loads swaps a finished load into reference_catalog.
// A database error answers 500 with its message.

import { z } from "zod";
import { secretsMatch } from "../auth.ts";
import {
  type LoadReferencesRequest,
  MAX_REFERENCE_ROWS_PER_REQUEST,
  REFERENCE_PROGRAMS,
  type ReferenceAbandonReply,
  type ReferenceBeginReply,
  type ReferenceCatalogRow,
  type ReferenceFinishReply,
  type ReferenceRowsReply,
  type ReferenceStatusReply,
} from "../reference_catalog.ts";
import { type JsonObject, jsonObjectSchema, type ReferenceDb } from "../types.ts";

export interface LoadReferencesDeps {
  /** LONGLINES_RELAY_SECRET; undefined when unset. */
  secret: string | undefined;
  db: () => ReferenceDb;
}

/** A load id or a row count: a non-negative safe integer, `message` for anything else. */
function countSchema(message: string): z.ZodType<number> {
  return z.number({ error: message }).int({ error: message }).min(0, { error: message });
}

const nullableText = z.string().nullable();
const nullableNumber = z.number().nullable();
const nullableInteger = z.number().int().nullable();
const nullableDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

// The staging rows our relay builds (ReferenceCatalogParser in reference_catalog.ts): strict.
// stage_reference_rows reads them with jsonb_to_recordset.
const rowSchema: z.ZodType<ReferenceCatalogRow> = z.strictObject({
  reference: z.string().min(1).max(64),
  name: nullableText,
  active: z.boolean(),
  location: nullableText,
  region: nullableText,
  country: nullableText,
  latitude: nullableNumber,
  longitude: nullableNumber,
  grid: nullableText,
  altitude_m: nullableInteger,
  points: nullableInteger,
  valid_from: nullableDate,
  valid_to: nullableDate,
});

const BEGIN_MESSAGE = "begin needs a pota, sota or wwff program and a version";
const ROWS_LOAD_MESSAGE = "rows needs a load";
const ROWS_COUNT_MESSAGE = `rows needs 1 to ${String(MAX_REFERENCE_ROWS_PER_REQUEST)} rows`;
const FINISH_MESSAGE = "finish needs a load and the rows staged";
const ABANDON_MESSAGE = "abandon needs a load and an error";

// Our relay's requests (referenceClient in relay/catalogs.ts): strict, one schema per action. Each
// part's message is the one the handler answers. Not annotated: a member of the discriminated
// union below must keep its literal action.
const statusRequestSchema = z.strictObject({ action: z.literal("status") });
const beginRequestSchema = z.strictObject({
  action: z.literal("begin"),
  program: z.enum(REFERENCE_PROGRAMS, { error: BEGIN_MESSAGE }),
  version: z.string({ error: BEGIN_MESSAGE })
    .max(100, { error: BEGIN_MESSAGE })
    .refine((version) => version.trim() !== "", { error: BEGIN_MESSAGE }),
});
// The rows are checked one by one once the envelope is (rowsRequest), so a bad row is named.
const rowsRequestSchema = z.strictObject({
  action: z.literal("rows"),
  load: countSchema(ROWS_LOAD_MESSAGE),
  rows: z.array(jsonObjectSchema, { error: ROWS_COUNT_MESSAGE })
    .min(1, { error: ROWS_COUNT_MESSAGE })
    .max(MAX_REFERENCE_ROWS_PER_REQUEST, { error: ROWS_COUNT_MESSAGE }),
});
const finishRequestSchema = z.strictObject({
  action: z.literal("finish"),
  load: countSchema(FINISH_MESSAGE),
  rows: countSchema(FINISH_MESSAGE),
});
const abandonRequestSchema = z.strictObject({
  action: z.literal("abandon"),
  load: countSchema(ABANDON_MESSAGE),
  // Kept to the first 1,000 characters, as stored.
  error: z.string({ error: ABANDON_MESSAGE }).transform((error) => error.slice(0, 1000)),
});

/** The rows action before its rows are checked. */
interface RowsEnvelope {
  action: "rows";
  load: number;
  rows: JsonObject[];
}

/** A request as the envelope schema reads it: every action but rows is final. */
type LoadEnvelope = Exclude<LoadReferencesRequest, { action: "rows" }> | RowsEnvelope;

const loadEnvelopeSchema: z.ZodType<LoadEnvelope> = z.discriminatedUnion("action", [
  statusRequestSchema,
  beginRequestSchema,
  rowsRequestSchema,
  finishRequestSchema,
  abandonRequestSchema,
], { error: "action must be status, begin, rows, finish or abandon" });

const rowsSchema: z.ZodType<ReferenceCatalogRow[]> = z.array(rowSchema);

/** The message of a ZodError's first issue: the one the hand-written checks reported. */
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

/** The rows request with each row checked, or a message naming the first bad one. */
function rowsRequest(envelope: RowsEnvelope): LoadReferencesRequest | string {
  const result = rowsSchema.safeParse(envelope.rows);
  if (!result.success) {
    return `every row must be a reference row: ${firstIssue(result.error, "malformed")}`;
  }
  return { action: "rows", load: envelope.load, rows: result.data };
}

/** The request, or a message saying what is wrong with it. */
export function parseLoadReferencesRequest(body: unknown): LoadReferencesRequest | string {
  if (!jsonObjectSchema.safeParse(body).success) {
    return "body must be a JSON object";
  }
  const result = loadEnvelopeSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue === undefined) {
      return "body is not a load-references request";
    }
    return issue.message;
  }
  const request = result.data;
  if (request.action === "rows") {
    return rowsRequest(request);
  }
  return request;
}

type Reply =
  | ReferenceStatusReply
  | ReferenceBeginReply
  | ReferenceRowsReply
  | ReferenceFinishReply
  | ReferenceAbandonReply;

async function run(request: LoadReferencesRequest, db: ReferenceDb): Promise<Reply> {
  switch (request.action) {
    case "status":
      return { status: await db.loadStatus() };
    case "begin":
      return { load: await db.beginLoad(request.program, request.version) };
    case "rows":
      return { staged: await db.stageRows(request.load, request.rows) };
    case "finish":
      return { state: await db.finishLoad(request.load, request.rows) };
    case "abandon":
      await db.abandonLoad(request.load, request.error);
      return { ok: true };
  }
}

export async function handleLoadReferences(
  req: Request,
  deps: LoadReferencesDeps,
): Promise<Response> {
  if (deps.secret === undefined || deps.secret === "") {
    console.error("load-references: missing environment variable LONGLINES_RELAY_SECRET");
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
    console.error(`load-references: reading the request body failed: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
  const request = parseLoadReferencesRequest(body);
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
    console.error(`load-references ${request.action}: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
