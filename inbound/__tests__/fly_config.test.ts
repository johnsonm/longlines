import { assert, assertEquals } from "@std/assert";
import { WEBHOOK_TIMEOUT_MS } from "../../supabase/functions/_shared/delivery/send.ts";
import { SHUTDOWN_GRACE_MS } from "../../sender/cluster_stream.ts";
import { DRAIN_MS } from "../inbound.ts";

// Fly Launch once overwrote inbound/fly.toml: kill_timeout fell back to Fly's 5 s default,
// which cuts the shutdown drain, and a public http_service with auto-stop appeared on a worker
// that serves no requests. Nothing else reads these files before a deploy, so these checks do.
// Simple line matching on purpose: no TOML dependency for two small files.

const repo = new URL("../../", import.meta.url);
/** Room past the shutdown deadline for the health server, the exit and Fly's own timing. */
const MARGIN_MS = 5_000;

function flyToml(app: string): string {
  return Deno.readTextFileSync(new URL(`${app}/fly.toml`, repo));
}

/** The file's lines without comments or surrounding blanks. */
function lines(toml: string): string[] {
  return toml.split("\n").map((line) => line.replace(/#.*$/, "").trim());
}

/** The top-level key's value as written (quotes removed), or null when it is absent. */
function topLevel(toml: string, key: string): string | null {
  for (const line of lines(toml)) {
    if (line.startsWith("[")) {
      // Keys after the first table header belong to that table (build.kill_timeout).
      return null;
    }
    const match = new RegExp(`^${key}\\s*=\\s*["']?([^"']*)["']?$`).exec(line);
    if (match !== null) {
      return match[1]!;
    }
  }
  return null;
}

/** The name in a `[table]` or `[[table]]` header line, or "" for any other line. */
function tableName(line: string): string {
  const header = /^\[+([^\]]+)\]+$/.exec(line);
  if (header === null) {
    return "";
  }
  return header[1]!.trim();
}

/** The lines of `[name]` (subtables included), or null when it is absent. */
function table(toml: string, name: string): string[] | null {
  let body: string[] | null = null;
  for (const line of lines(toml)) {
    if (line.startsWith("[")) {
      const header = tableName(line);
      if (header === name) {
        body = [];
        continue;
      }
      if (body !== null && !header.startsWith(`${name}.`)) {
        return body;
      }
    }
    if (body !== null && line !== "") {
      body.push(line);
    }
  }
  return body;
}

/** "30s", "1m30s" or "500ms" in milliseconds. */
function durationMs(value: string): number {
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  let read = "";
  let ms = 0;
  for (const part of value.matchAll(/(\d+)(ms|s|m|h)/g)) {
    read += part[0];
    ms += Number(part[1]) * units[part[2]!]!;
  }
  assertEquals(read, value, `unreadable duration ${value}`);
  return ms;
}

function killTimeoutMs(app: string): number {
  const value = topLevel(flyToml(app), "kill_timeout");
  assert(value !== null, `${app}/fly.toml sets no kill_timeout (Fly's default is 5 s)`);
  return durationMs(value);
}

Deno.test("the helpers read top-level keys, tables and durations", function (): void {
  const toml = 'a = "1"\n# b = 2\n[t]\n  x = 1\n  [t.sub]\n    y = 2\n[u]\n  c = "3"\n';
  assertEquals(topLevel(toml, "a"), "1");
  assertEquals(topLevel(toml, "b"), null);
  assertEquals(topLevel(toml, "c"), null);
  assertEquals(table(toml, "t"), ["x = 1", "[t.sub]", "y = 2"]);
  assertEquals(table(toml, "u"), ['c = "3"']);
  assertEquals(table(toml, "v"), null);
  assertEquals(durationMs("1m30s"), 90_000);
});

Deno.test("inbound's kill_timeout outlasts the shutdown drain", function (): void {
  assertEquals(topLevel(flyToml("inbound"), "kill_signal"), "SIGINT");
  assert(
    killTimeoutMs("inbound") >= DRAIN_MS + MARGIN_MS,
    `kill_timeout must be at least DRAIN_MS (${String(DRAIN_MS)} ms) plus ${String(MARGIN_MS)} ms`,
  );
});

Deno.test("inbound serves no public traffic and restarts always", function (): void {
  const toml = flyToml("inbound");
  assertEquals(table(toml, "http_service"), null);
  assertEquals(table(toml, "services"), null);
  assertEquals(table(toml, "restart"), ['policy = "always"']);
});

Deno.test("the sender's kill_timeout outlasts closing the streams and a send", function (): void {
  assertEquals(topLevel(flyToml("sender"), "kill_signal"), "SIGINT");
  // Shutdown closes the relays' streams (SHUTDOWN_GRACE_MS), then waits for the cycle in
  // flight, whose sends each stop at their 10 s timeout.
  assert(killTimeoutMs("sender") >= SHUTDOWN_GRACE_MS + WEBHOOK_TIMEOUT_MS + MARGIN_MS);
});

Deno.test("the sender's http_service never stops the machine", function (): void {
  const service = table(flyToml("sender"), "http_service");
  if (service === null) {
    return;
  }
  assert(service.includes("auto_stop_machines = false"), "auto_stop_machines must be false");
  assert(service.includes("auto_start_machines = false"), "auto_start_machines must be false");
});
