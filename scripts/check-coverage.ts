// Fails when line coverage of the Edge Functions, of the relay or of the sender
// drops below the threshold. Each is checked on its own so one cannot carry
// another.
//
// `deno coverage` only reports modules a test loaded, so a source file no test
// imports would silently vanish from the total. This also fails when any
// module is missing from the report, except the process entrypoints
// (Deno.serve shells, relay/main.ts and sender/main.ts) and type-only files.
//
// Usage: deno run --allow-read scripts/check-coverage.ts <lcov.info> <min line %>

const lcovPath = Deno.args[0];
const minArg = Deno.args[1];
if (lcovPath === undefined || lcovPath === "" || minArg === undefined || minArg === "") {
  console.error("usage: check-coverage.ts <lcov.info> <min line %>");
  Deno.exit(2);
}
const min = Number(minArg);
// A mistyped minimum ("80%") is NaN, and `pct < NaN` is never true, so every root would pass.
if (!Number.isFinite(min) || min <= 0 || min > 100) {
  console.error(`check-coverage.ts: the minimum must be a number in (0, 100], got "${minArg}"`);
  Deno.exit(2);
}

const ROOTS = [
  {
    name: "Edge Function",
    dir: new URL("../supabase/functions/", import.meta.url).pathname,
    skip: [/\/__tests__\//, /^[^/]+\/index\.ts$/, /(^|\/)types\.ts$/],
  },
  {
    name: "Relay",
    dir: new URL("../relay/", import.meta.url).pathname,
    skip: [/^__tests__\//, /^main\.ts$/],
  },
  {
    name: "Sender",
    dir: new URL("../sender/", import.meta.url).pathname,
    skip: [/^__tests__\//, /^main\.ts$/],
  },
];

interface Totals {
  found: number;
  hit: number;
  reported: Set<string>;
}
const totals = new Map<string, Totals>(
  ROOTS.map((r) => [r.dir, { found: 0, hit: 0, reported: new Set<string>() }]),
);

let current: Totals | undefined;
let currentRel = "";
for (const line of (await Deno.readTextFile(lcovPath)).split("\n")) {
  if (line.startsWith("SF:")) {
    const path = line.slice(3);
    const root = ROOTS.find((r) => path.startsWith(r.dir));
    if (root === undefined) {
      current = undefined;
      currentRel = "";
    } else {
      current = totals.get(root.dir);
      currentRel = path.slice(root.dir.length);
    }
  } else if (current === undefined) {
    continue;
  } else if (line.startsWith("LF:")) {
    current.found += Number(line.slice(3));
  } else if (line.startsWith("LH:")) {
    current.hit += Number(line.slice(3));
  } else if (line === "end_of_record") {
    current.reported.add(currentRel);
  }
}

async function* sources(dir: string, prefix: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix + entry.name;
    if (entry.isDirectory) {
      yield* sources(`${dir}${entry.name}/`, `${rel}/`);
    } else if (rel.endsWith(".ts")) {
      yield rel;
    }
  }
}

let failed = false;
for (const root of ROOTS) {
  const total = totals.get(root.dir);
  if (total === undefined) {
    throw new Error(`check-coverage.ts: no totals for ${root.dir}`);
  }
  const missing: string[] = [];
  for await (const rel of sources(root.dir, "")) {
    if (!root.skip.some((re) => re.test(rel)) && !total.reported.has(rel)) {
      missing.push(rel);
    }
  }
  let pct = 0;
  if (total.found !== 0) {
    pct = (total.hit / total.found) * 100;
  }
  const lines = `${String(total.hit)}/${String(total.found)}`;
  console.log(`${root.name} line coverage: ${pct.toFixed(1)}% (${lines}, minimum ${String(min)}%)`);
  if (missing.length > 0) {
    console.error(`No test loads these modules:\n  ${missing.sort().join("\n  ")}`);
  }
  if (pct < min || missing.length > 0) {
    failed = true;
  }
}
if (failed) {
  Deno.exit(1);
}
