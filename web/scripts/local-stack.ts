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
  return {
    apiUrl,
    dbUrl: field("DB_URL"),
    anonKey: field("ANON_KEY"),
    serviceRoleKey: field("SERVICE_ROLE_KEY"),
    studioUrl: field("STUDIO_URL"),
    mailUrl: field("MAILPIT_URL"),
  };
}

export function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
