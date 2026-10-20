// Shared helpers for the local-development scripts in this folder. Everything here talks to the
// stack started by `supabase start`; nothing reads or writes the hosted project.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const webRoot = fileURLToPath(new URL("../", import.meta.url));

// Docker names the database container after `project_id` in supabase/config.toml.
export const dbContainer = "supabase_db_longlines";

export interface LocalStatus {
  apiUrl: string;
  /** The stack's Postgres as the postgres user; what the sender and its database tests connect to. */
  dbUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  studioUrl: string;
  mailUrl: string;
}

export class StackNotRunning extends Error {}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True for a postgres:// or postgresql:// URL whose host is this machine; false for anything else, unparsable included. */
export function isLocalDbUrl(dbUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(dbUrl);
  } catch {
    return false;
  }
  return (url.protocol === "postgres:" || url.protocol === "postgresql:") && LOCAL_HOSTS.has(url.hostname.toLowerCase());
}

export function localStatus(): LocalStatus {
  const result = spawnSync("supabase", ["status", "--output", "json", "--workdir", repoRoot], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`could not run the Supabase CLI (${result.error.message}); is it installed?`);
  }
  if (result.status !== 0) {
    throw new StackNotRunning("the local stack is not running; start it with `npm run supabase:start`");
  }
  // The CLI can print warnings after the JSON object, so keep only the object.
  const json = /^\{[\s\S]*?^\}/m.exec(result.stdout);
  if (!json) throw new Error("could not parse `supabase status --output json`");
  const status = JSON.parse(json[0]) as Record<string, unknown>;

  const field = (name: string): string => {
    const value = status[name];
    if (typeof value !== "string" || value === "") {
      throw new Error(`\`supabase status\` did not report ${name}`);
    }
    return value;
  };

  const apiUrl = field("API_URL");
  // These scripts send the service-role key; refuse anything that is not this machine.
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) {
    throw new Error(`refusing to use a non-local API URL: ${apiUrl}`);
  }
  // The sender script hands this to a process that allows insecure destinations, and check-all's db
  // test writes rows through it; refuse anything that is not this machine too.
  const dbUrl = field("DB_URL");
  if (!isLocalDbUrl(dbUrl)) {
    throw new Error(`refusing to use a non-local database URL (host ${hostOf(dbUrl)})`);
  }
  return {
    apiUrl,
    dbUrl,
    anonKey: field("ANON_KEY"),
    serviceRoleKey: field("SERVICE_ROLE_KEY"),
    studioUrl: field("STUDIO_URL"),
    mailUrl: field("MAILPIT_URL"),
  };
}

/** The URL's host for an error message, never its password. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || "missing";
  } catch {
    return "unparsable";
  }
}

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
