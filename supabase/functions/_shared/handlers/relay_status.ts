// The relay's heartbeat for the Health page (relay/status.ts), once a minute
// with the relay secret: when the process started, its RSS, its reconnects
// since then and each feed's connection. One record_relay_heartbeat call; SQL
// keeps at most one row per 30 seconds and only known feed ids.

import type { SupabaseClient } from "@supabase/supabase-js";
import { secretsMatch } from "../auth.ts";

export interface RelayStatus {
  started_at: string;
  rss_bytes: number;
  reconnects: number;
  feeds: Array<{ id: string; connected: boolean }>;
}

export interface RelayStatusDeps {
  /** LONGLINES_RELAY_SECRET; undefined when unset. */
  secret: string | undefined;
  /** Service-role client for record_relay_heartbeat(). */
  db: () => SupabaseClient;
}

const MAX_FEEDS = 10;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

/** The heartbeat, or a message saying what is wrong with it. */
export function parseRelayStatus(body: unknown): RelayStatus | string {
  if (!isObject(body)) {
    return "body must be a JSON object";
  }
  const started_at = body.started_at;
  const rss_bytes = body.rss_bytes;
  const reconnects = body.reconnects;
  const feeds = body.feeds;
  if (typeof started_at !== "string" || Number.isNaN(Date.parse(started_at))) {
    return "started_at must be a time";
  }
  if (!isCount(rss_bytes) || !isCount(reconnects)) {
    return "rss_bytes and reconnects must be counts";
  }
  if (!Array.isArray(feeds) || feeds.length > MAX_FEEDS) {
    return `feeds must be at most ${String(MAX_FEEDS)} items`;
  }
  const parsed: RelayStatus["feeds"] = [];
  for (const feed of feeds) {
    if (!isObject(feed) || typeof feed.id !== "string" || typeof feed.connected !== "boolean") {
      return "every feed needs an id and connected";
    }
    parsed.push({ id: feed.id, connected: feed.connected });
  }
  return { started_at, rss_bytes, reconnects, feeds: parsed };
}

export async function handleRelayStatus(req: Request, deps: RelayStatusDeps): Promise<Response> {
  if (deps.secret === undefined || deps.secret === "") {
    console.error("relay-status: missing environment variable LONGLINES_RELAY_SECRET");
    return Response.json({ error: "relay secret is not configured" }, { status: 500 });
  }
  let header = req.headers.get("x-relay-secret");
  if (header === null || header === undefined) {
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
  } catch {
    return Response.json({ error: "request body is not JSON" }, { status: 400 });
  }
  const status = parseRelayStatus(body);
  if (typeof status === "string") {
    return Response.json({ error: status }, { status: 400 });
  }

  const result = await deps.db().rpc("record_relay_heartbeat", {
    p_started_at: status.started_at,
    p_rss_bytes: status.rss_bytes,
    p_reconnects: status.reconnects,
    p_feeds: status.feeds,
  });
  const error = result.error;
  if (error !== null) {
    console.error(`relay-status: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}
