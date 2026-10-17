// Removes every Docker container, volume and network of this project's local Supabase stack.
// Use it when the stack is stuck or corrupted and `supabase stop` / `db reset` do not help.
// Only objects labelled with this project are touched; other projects' stacks keep running.
// All local data is lost. Run `npm run supabase:start` afterwards to rebuild from migrations.
import { spawnSync } from "node:child_process";
import { repoRoot } from "./local-stack.ts";

const LABEL = "label=com.supabase.cli.project=longlines";

// Every docker command that failed; the summary reports them instead of success.
const failures: string[] = [];

/** The command's output lines, or null when docker ran but failed (stderr is printed and recorded). */
function docker(args: string[]): string[] | null {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) {
    console.error(`✗ could not run docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    console.error(`  ✗ docker ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    failures.push(`docker ${args.join(" ")}`);
    return null;
  }
  return result.stdout.split("\n").filter(Boolean);
}

function removeAll(kind: string, list: string[], remove: string[]): void {
  const ids = docker([...list, "--filter", LABEL]);
  if (ids === null) return;
  console.log(`\nRemoving ${kind}: ${ids.length === 0 ? "none found" : ids.length}`);
  for (const id of ids) {
    if (docker([...remove, id]) !== null) console.log(`  removed ${id}`);
  }
}

console.log("Stopping the local stack without a backup...");
spawnSync("supabase", ["stop", "--no-backup", "--workdir", repoRoot], { stdio: "inherit" });

removeAll("containers", ["ps", "-aq"], ["rm", "-f"]);
removeAll("volumes", ["volume", "ls", "-q"], ["volume", "rm", "-f"]);
removeAll("networks", ["network", "ls", "-q"], ["network", "rm"]);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} docker command(s) failed; the stack may be partly removed:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\n✓ Local Supabase stack removed. Start fresh with `npm run supabase:start`.");
}
