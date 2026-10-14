import { assertEquals } from "@std/assert";

// `supabase functions deploy` bundles each function with its own deno.json as
// the import map; the root deno.json that tests and `deno task check` use is
// not consulted. A function without one passes CI and fails to deploy
// ("Relative import path ... not prefixed"), as import-cty first did.

const functionsDir = new URL("../../", import.meta.url);
const root = JSON.parse(Deno.readTextFileSync(new URL("../../../../deno.json", import.meta.url)));

Deno.test("every function has a deno.json mapping supabase-js like the root one", () => {
  const missing: string[] = [];
  for (const entry of Deno.readDirSync(functionsDir)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    const path = new URL(`${entry.name}/deno.json`, functionsDir);
    let config;
    try {
      config = JSON.parse(Deno.readTextFileSync(path));
    } catch {
      missing.push(entry.name);
      continue;
    }
    assertEquals(
      config.imports?.["@supabase/supabase-js"],
      root.imports["@supabase/supabase-js"],
      `${entry.name}/deno.json maps @supabase/supabase-js differently`,
    );
  }
  assertEquals(missing, [], "functions without a deno.json");
});

Deno.test("archive's deno.json maps hyparquet-writer like the root one", () => {
  const config = JSON.parse(Deno.readTextFileSync(new URL("archive/deno.json", functionsDir)));
  assertEquals(config.imports?.["hyparquet-writer"], root.imports["hyparquet-writer"]);
});

// isServiceRole trusts a JWT's role claim without checking its signature,
// because the gateway has already verified it. A function deployed with
// verify_jwt = false gets no such check, so a forged token would pass.

const sharedAuth = new URL("../auth.ts", import.meta.url).href;
// Static imports and re-exports with a clause, side-effect imports (`import "./x.ts"`, no clause) and
// dynamic imports. A clause cannot hold a quote or a semicolon, so a side-effect import is never
// swallowed into the next statement's clause.
const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:([^;"'`]*?)\s*\bfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

interface ModuleImport {
  specifier: string;
  /** The import or export clause; "" for a side-effect import, "*" for a dynamic one (the whole module). */
  clause: string;
}

/** Every import, re-export and dynamic import in a module's source. */
function importsOf(source: string): ModuleImport[] {
  return [...source.matchAll(importPattern)].map(([, clause, specifier, dynamic]) =>
    dynamic
      ? { specifier: dynamic, clause: "*" }
      : { specifier: specifier ?? "", clause: clause ?? "" }
  );
}

/**
 * True when an import or export clause from auth.ts can reach isServiceRole:
 * the name itself, a namespace import, or an `export *` barrel.
 */
function exposesIsServiceRole(clause: string): boolean {
  return /\bisServiceRole\b|\*\s+as\b|^\*$/.test(clause.trim());
}

/** Functions that config.toml deploys with verify_jwt = false. */
function functionsWithoutJwt(): string[] {
  const config = Deno.readTextFileSync(new URL("../../../config.toml", import.meta.url));
  const open: string[] = [];
  let section: string | null = null;
  for (const line of config.split("\n")) {
    const header = /^\[functions\.([\w-]+)\]/.exec(line);
    if (header) section = header[1] ?? null;
    else if (line.startsWith("[")) section = null;
    else if (section && /^verify_jwt\s*=\s*false\b/.test(line)) open.push(section);
  }
  return open;
}

/** Modules reachable from a function's entrypoint that import isServiceRole from auth.ts. */
function modulesUsingIsServiceRole(fn: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [new URL(`${fn}/index.ts`, functionsDir).href];
  while (queue.length > 0) {
    const href = queue.pop()!;
    if (seen.has(href)) continue;
    seen.add(href);
    const source = Deno.readTextFileSync(new URL(href));
    for (const { specifier, clause } of importsOf(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = new URL(specifier, href).href;
      if (target === sharedAuth && exposesIsServiceRole(clause)) found.push(href);
      queue.push(target);
    }
  }
  return found;
}

Deno.test("the isServiceRole check recognizes every way to reach it", () => {
  for (
    const clause of [
      "{ isServiceRole }",
      "{\n  bearerToken,\n  isServiceRole,\n}",
      "* as auth",
      "*",
    ]
  ) {
    assertEquals(exposesIsServiceRole(clause), true, clause);
  }
  for (const clause of ["{ bearerToken }", "{ secretsMatch, userFromRequest }"]) {
    assertEquals(exposesIsServiceRole(clause), false, clause);
  }
});

Deno.test("the import walker sees side-effect, re-export and dynamic imports", () => {
  const source = [
    'import "./setup.ts";',
    'import { a, b } from "./a.ts";',
    'import type { T } from "./types.ts";',
    'import * as auth from "../auth.ts";',
    'export { c } from "./c.ts";',
    'export * from "./barrel.ts";',
    'const lazy = await import("./lazy.ts");',
    'import {\n  d,\n} from "./d.ts";',
    'export const x = "not an import";',
  ].join("\n");
  assertEquals(importsOf(source), [
    { specifier: "./setup.ts", clause: "" },
    { specifier: "./a.ts", clause: "{ a, b }" },
    { specifier: "./types.ts", clause: "{ T }" },
    { specifier: "../auth.ts", clause: "* as auth" },
    { specifier: "./c.ts", clause: "{ c }" },
    { specifier: "./barrel.ts", clause: "*" },
    { specifier: "./lazy.ts", clause: "*" },
    { specifier: "./d.ts", clause: "{\n  d,\n}" },
  ]);
});

Deno.test("the isServiceRole check finds the functions that use it", () => {
  for (const fn of ["deliver", "archive", "import-cty"]) {
    assertEquals(modulesUsingIsServiceRole(fn).length > 0, true, `${fn} uses isServiceRole`);
  }
});

Deno.test("no verify_jwt = false function imports isServiceRole", () => {
  const open = functionsWithoutJwt();
  for (const fn of ["sign-in", "ingest-rbn", "callsign-profile"]) {
    assertEquals(open.includes(fn), true, `config.toml lists ${fn} with verify_jwt = false`);
  }
  const offenders = open.flatMap((fn) => modulesUsingIsServiceRole(fn).map((m) => `${fn}: ${m}`));
  assertEquals(offenders, [], "verify_jwt = false functions reaching isServiceRole");
});
