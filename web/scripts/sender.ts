// Runs the outbound sender (sender/main.ts) against the local stack. Opt in: it is not part of
// `npm run dev:full`, because a sender polling the local queue every few seconds is only wanted
// while working on delivery.
//
//   npm run sender
//
// SENDER_DATABASE_URL is the stack's Postgres from `supabase status` (the postgres user; the
// delivery_sender role has no password locally). LONGLINES_ALLOW_INSECURE_DESTINATIONS defaults to
// 1 so a plain-http receiver on this machine can stand in for a destination; the sender itself
// refuses that setting with a non-local database. The VAPID triple and any other variable in
// supabase/functions/.env (the file `supabase functions serve` reads) are passed through, so push
// behaves as it does for the Edge Functions. The --allow-env list is the one in sender/Dockerfile,
// so a local run has production's permissions. Ctrl+C stops the sender the way Fly does (SIGINT).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, localStatus, repoRoot } from "./local-stack.ts";

/** KEY=value lines of a dotenv file, without quotes or interpolation; comments and blanks skipped. */
function dotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith("#")) continue;
    values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

let status;
try {
  status = localStatus();
} catch (error) {
  fail((error as Error).message);
}

const dockerfile = readFileSync(join(repoRoot, "sender", "Dockerfile"), "utf8");
const allowEnv = /--allow-env=([^"]+)"/.exec(dockerfile)?.[1];
if (!allowEnv) fail("could not read the --allow-env list from sender/Dockerfile");

const functionsEnv = dotenv(join(repoRoot, "supabase", "functions", ".env"));
const env: Record<string, string> = {
  LONGLINES_ALLOW_INSECURE_DESTINATIONS: "1",
  ...Object.fromEntries(
    Object.entries(functionsEnv).filter(([key]) => allowEnv.split(",").includes(key)),
  ),
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => allowEnv.split(",").includes(entry[0]) && entry[1] !== undefined,
    ),
  ),
  SENDER_DATABASE_URL: status.dbUrl,
};

console.log(`→ sender against ${status.dbUrl.replace(/:[^:@/]+@/, ":***@")}`);
if (!env.LONGLINES_VAPID_PRIVATE_KEY) {
  console.log("  (no LONGLINES_VAPID_* in supabase/functions/.env: push sends will fail, the rest works)");
}

const child = spawn(
  "deno",
  ["run", "--allow-net", `--allow-env=${allowEnv}`, "sender/main.ts"],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
  });
}
child.on("error", (error) => fail(`could not start deno: ${error.message}`));
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 0 : 1);
});
