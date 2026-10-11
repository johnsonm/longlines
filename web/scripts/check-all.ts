// Runs the checks from .github/workflows/ci.yml against this checkout and the local stack, then
// prints a summary. Every step runs even when an earlier one fails.
//
//   node scripts/check-all.ts              # everything
//   node scripts/check-all.ts deno web     # only some groups: deno, db, web
//   node scripts/check-all.ts --fresh      # `supabase db reset` first, like CI's fresh Postgres
//
// The local stack is shared by every worktree, and the pgTAP suites assume an empty raw_spots and
// empty pgmq queues, so the db group can fail locally while CI is green. The runner warns when the
// database's migrations differ from this checkout's. --fresh resets the database to this checkout
// first, which wipes local data for every worktree.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dbContainer, localStatus, repoRoot, StackNotRunning, webRoot } from "./local-stack.ts";

const GROUPS = ["deno", "db", "web"] as const;
type Group = (typeof GROUPS)[number];

interface Step {
  group: Group;
  name: string;
  cmd: string;
  args: string[];
  cwd: string;
  input?: string;
}

interface Outcome {
  step: Step;
  ok: boolean;
  seconds: number;
  note?: string;
}

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const requested = args.filter((arg) => !arg.startsWith("--"));
for (const group of requested) {
  if (!(GROUPS as readonly string[]).includes(group)) {
    console.error(`unknown group "${group}"; expected one of: ${GROUPS.join(", ")}`);
    process.exit(2);
  }
}
const groups = new Set<string>(requested.length > 0 ? requested : GROUPS);

const workdir = ["--workdir", repoRoot];
const steps: Step[] = [
  {
    group: "deno",
    name: "fmt --check",
    cmd: "deno",
    args: ["fmt", "--check", "supabase/functions", "scripts", "relay", "deno.json"],
    cwd: repoRoot,
  },
  { group: "deno", name: "lint", cmd: "deno", args: ["task", "lint"], cwd: repoRoot },
  { group: "deno", name: "check", cmd: "deno", args: ["task", "check"], cwd: repoRoot },
  { group: "deno", name: "test", cmd: "deno", args: ["task", "test"], cwd: repoRoot },
  ...(fresh
    ? [{ group: "db" as const, name: "db reset", cmd: "supabase", args: ["db", "reset", ...workdir], cwd: repoRoot }]
    : []),
  {
    group: "db",
    name: "db lint",
    cmd: "supabase",
    args: ["db", "lint", "--fail-on", "error", ...workdir],
    cwd: repoRoot,
  },
  { group: "db", name: "pgTAP", cmd: "supabase", args: ["test", "db", ...workdir], cwd: repoRoot },
  {
    group: "db",
    name: "smoke test",
    cmd: "docker",
    args: ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q"],
    cwd: repoRoot,
    input: readFileSync(join(repoRoot, "scripts", "smoke-test.sql"), "utf8"),
  },
  { group: "web", name: "lint", cmd: "npm", args: ["run", "lint"], cwd: webRoot },
  { group: "web", name: "test", cmd: "npm", args: ["test"], cwd: webRoot },
  { group: "web", name: "build", cmd: "npm", args: ["run", "build"], cwd: webRoot },
];

// The local stack is shared by every worktree, so its database can carry another branch's
// migrations. Returns a description of the difference, or undefined when they match.
function migrationDrift(): string | undefined {
  const result = spawnSync(
    "docker",
    ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-Atc", "select version from supabase_migrations.schema_migrations"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const applied = new Set(result.stdout.split("\n").filter(Boolean));
  const files = new Set(
    readdirSync(join(repoRoot, "supabase", "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.split("_")[0] ?? name),
  );
  const extra = [...applied].filter((version) => !files.has(version));
  const missing = [...files].filter((version) => !applied.has(version));
  if (extra.length === 0 && missing.length === 0) return undefined;
  return [
    extra.length > 0 ? `applied but not in this checkout: ${extra.join(", ")}` : "",
    missing.length > 0 ? `in this checkout but not applied: ${missing.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

// The db steps need the local stack; report them as failed rather than letting each one
// produce its own connection error.
let stackProblem: string | undefined;
let drift: string | undefined;
if (groups.has("db")) {
  try {
    localStatus();
    if (!fresh) drift = migrationDrift();
  } catch (error) {
    if (!(error instanceof StackNotRunning)) throw error;
    stackProblem = error.message;
  }
}
if (drift !== undefined) {
  console.log(`\x1b[33m⚠ The local database does not match this checkout's migrations (${drift}).\x1b[0m`);
}

const outcomes: Outcome[] = [];
for (const step of steps.filter((s) => groups.has(s.group))) {
  if (step.group === "db" && stackProblem !== undefined) {
    outcomes.push({ step, ok: false, seconds: 0, note: stackProblem });
    continue;
  }
  console.log(`\n\x1b[1m▶ ${step.group}: ${step.name}\x1b[0m`);
  const started = performance.now();
  const result = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    stdio: [step.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    input: step.input,
  });
  const seconds = (performance.now() - started) / 1000;
  const note = result.error ? `could not run ${step.cmd}: ${result.error.message}` : undefined;
  outcomes.push({ step, ok: result.status === 0, seconds, note });
}

console.log("\n\x1b[1mSummary\x1b[0m");
const nameWidth = Math.max(...outcomes.map((o) => `${o.step.group} ${o.step.name}`.length));
for (const outcome of outcomes) {
  const mark = outcome.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const label = `${outcome.step.group} ${outcome.step.name}`.padEnd(nameWidth);
  const detail = outcome.note ?? `${outcome.seconds.toFixed(1)}s`;
  console.log(`  ${mark} ${label}  ${detail}`);
}

const failed = outcomes.filter((o) => !o.ok);
if (failed.some((o) => o.step.group === "db") && !fresh && stackProblem === undefined) {
  console.log(
    drift !== undefined
      ? `\n\x1b[33m⚠ The local database has a different migration set (${drift}).\x1b[0m\n` +
        "The db failures may come from another worktree's branch, not this one."
      : "\npgTAP assumes an empty raw_spots and empty queues; local ingest runs can break that.",
  );
  console.log(
    "Rerun with `npm run test:all:fresh` to reset the local database to this checkout first.\n" +
      "That wipes local data for every worktree sharing the stack.",
  );
}
console.log(failed.length === 0 ? "\nAll checks passed." : `\n${failed.length} check(s) failed.`);
process.exitCode = failed.length === 0 ? 0 : 1;
