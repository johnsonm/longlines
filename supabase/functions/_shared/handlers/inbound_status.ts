// The inbound worker's heartbeat for the Health page (inbound/status.ts), once a minute
// with the inbound secret: when the process started, its RSS, its reconnects
// since then and each feed's connection. One record_inbound_heartbeat call; SQL
// keeps at most one row per 30 seconds and only known feed ids.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { secretsMatch } from "../auth.ts";
import { logError } from "../sentry.ts";

/** One feed's connection in a heartbeat. */
export interface InboundFeedStatus {
  id: string;
  connected: boolean;
}

export interface InboundStatus {
  started_at: string;
  rss_bytes: number;
  reconnects: number;
  feeds: InboundFeedStatus[];
}

export interface InboundStatusDeps {
  /** LONGLINES_INBOUND_SECRET; undefined when unset. */
  secret: string | undefined;
  /** Service-role client for record_inbound_heartbeat(). */
  db: () => SupabaseClient;
}

const MAX_FEEDS = 10;

const COUNTS_MESSAGE = "rss_bytes and reconnects must be counts";
const FEEDS_MESSAGE = `feeds must be at most ${String(MAX_FEEDS)} items`;
const FEED_MESSAGE = "every feed needs an id and connected";

/** A non-negative safe integer; `message` for anything else. */
function countSchema(message: string): z.ZodType<number> {
  return z.number({ error: message }).int({ error: message }).min(0, { error: message });
}

// One feed of our inbound's heartbeat (inbound/status.ts): strict.
const inboundFeedStatusSchema: z.ZodType<InboundFeedStatus> = z.strictObject({
  id: z.string({ error: FEED_MESSAGE }),
  connected: z.boolean({ error: FEED_MESSAGE }),
}, { error: FEED_MESSAGE });

// Our inbound's heartbeat body (statusBody in inbound/status.ts): strict. Each part's message is the
// one the handler answers, and the first issue is the first part in this order that is wrong.
const inboundStatusSchema: z.ZodType<InboundStatus> = z.strictObject({
  started_at: z.string({ error: "started_at must be a time" })
    .refine((text) => !Number.isNaN(Date.parse(text)), { error: "started_at must be a time" }),
  rss_bytes: countSchema(COUNTS_MESSAGE),
  reconnects: countSchema(COUNTS_MESSAGE),
  feeds: z.array(inboundFeedStatusSchema, { error: FEEDS_MESSAGE })
    .max(MAX_FEEDS, { error: FEEDS_MESSAGE }),
}, { error: "body must be a JSON object with only started_at, rss_bytes, reconnects and feeds" });

/** The heartbeat, or a message saying what is wrong with it. */
export function parseInboundStatus(body: unknown): InboundStatus | string {
  const result = inboundStatusSchema.safeParse(body);
  if (result.success) {
    return result.data;
  }
  return firstIssue(result.error);
}

/** The message of a ZodError's first issue: the one the hand-written checks reported. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "body is not a heartbeat";
  }
  return issue.message;
}

export async function handleInboundStatus(
  req: Request,
  deps: InboundStatusDeps,
): Promise<Response> {
  if (deps.secret === undefined || deps.secret === "") {
    logError("inbound-status: missing environment variable LONGLINES_INBOUND_SECRET", undefined);
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
    // Bad JSON is the inbound worker's fault; anything else (a broken stream) is ours.
    if (error instanceof SyntaxError) {
      return Response.json({ error: "request body is not JSON" }, { status: 400 });
    }
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    logError(`inbound-status: reading the request body failed: ${message}`, error);
    return Response.json({ error: message }, { status: 500 });
  }
  const status = parseInboundStatus(body);
  if (typeof status === "string") {
    return Response.json({ error: status }, { status: 400 });
  }

  const result = await deps.db().rpc("record_inbound_heartbeat", {
    p_started_at: status.started_at,
    p_rss_bytes: status.rss_bytes,
    p_reconnects: status.reconnects,
    p_feeds: status.feeds,
  });
  const error = result.error;
  if (error !== null) {
    logError(`inbound-status: ${error.message}`, error);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}
