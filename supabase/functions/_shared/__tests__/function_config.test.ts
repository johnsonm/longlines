import { assertEquals } from "@std/assert";

// `supabase functions deploy` bundles each function with its own deno.json as
// the import map; the root deno.json that tests and `deno task check` use is
// not consulted. A function without one passes CI and fails to deploy
// ("Relative import path ... not prefixed"), as import-cty first did.

const functionsDir = new URL("../../", import.meta.url);
const root = JSON.parse(Deno.readTextFileSync(new URL("../../../../deno.json", import.meta.url)));

// A deploy reads only the function's deno.json, never deno.lock, so a range
// such as `@2` ships whatever release npm has that day.
Deno.test("the root deno.json pins every npm package to an exact version", function (): void {
  const ranged: string[] = [];
  for (const specifier of Object.values(root.imports)) {
    if (typeof specifier !== "string" || !specifier.startsWith("npm:")) {
      continue;
    }
    if (!/@\d+\.\d+\.\d+$/.test(specifier)) {
      ranged.push(specifier);
    }
  }
  assertEquals(ranged, [], "npm imports without an exact version");
});

Deno.test(
  "every function has a deno.json mapping supabase-js like the root one",
  function (): void {
    const missing: string[] = [];
    for (const entry of Deno.readDirSync(functionsDir)) {
      if (!entry.isDirectory || entry.name.startsWith("_")) {
        continue;
      }
      const path = new URL(`${entry.name}/deno.json`, functionsDir);
      let config;
      try {
        config = JSON.parse(Deno.readTextFileSync(path));
      } catch {
        missing.push(entry.name);
        continue;
      }
      let mapped: unknown = undefined;
      if (config.imports !== null && config.imports !== undefined) {
        mapped = config.imports["@supabase/supabase-js"];
      }
      assertEquals(
        mapped,
        root.imports["@supabase/supabase-js"],
        `${entry.name}/deno.json maps @supabase/supabase-js differently`,
      );
    }
    assertEquals(missing, [], "functions without a deno.json");
  },
);

Deno.test(
  "archive's and convert-archive's deno.json map hyparquet-writer like the root one",
  function (): void {
    for (const name of ["archive", "convert-archive"]) {
      const config = JSON.parse(Deno.readTextFileSync(new URL(`${name}/deno.json`, functionsDir)));
      let mapped: unknown = undefined;
      if (config.imports !== null && config.imports !== undefined) {
        mapped = config.imports["hyparquet-writer"];
      }
      assertEquals(mapped, root.imports["hyparquet-writer"], name);
    }
  },
);

// The root deno.lock is the only lock. A function's own would pin the versions it was made
// with, and nothing keeps it in step when the root and the function's deno.json move on.
Deno.test("no function has a deno.lock of its own", function (): void {
  const locked: string[] = [];
  for (const entry of Deno.readDirSync(functionsDir)) {
    if (!entry.isDirectory) {
      continue;
    }
    try {
      Deno.statSync(new URL(`${entry.name}/deno.lock`, functionsDir));
      locked.push(entry.name);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
  assertEquals(locked, [], "function directories with a deno.lock");
});

// Zod validates external data (_shared/validate.ts), which every function will load.
Deno.test("every function's deno.json maps zod like the root one", function (): void {
  for (const entry of Deno.readDirSync(functionsDir)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) {
      continue;
    }
    const path = new URL(`${entry.name}/deno.json`, functionsDir);
    const config = JSON.parse(Deno.readTextFileSync(path));
    let mapped: unknown = undefined;
    if (config.imports !== null && config.imports !== undefined) {
      mapped = config.imports["zod"];
    }
    assertEquals(mapped, root.imports["zod"], `${entry.name}/deno.json maps zod differently`);
  }
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
  const imports: ModuleImport[] = [];
  for (const match of source.matchAll(importPattern)) {
    const clause = match[1];
    const specifier = match[2];
    const dynamic = match[3];
    if (dynamic) {
      imports.push({ specifier: dynamic, clause: "*" });
      continue;
    }
    let staticSpecifier = specifier;
    if (staticSpecifier === null || staticSpecifier === undefined) {
      staticSpecifier = "";
    }
    let staticClause = clause;
    if (staticClause === null || staticClause === undefined) {
      staticClause = "";
    }
    imports.push({ specifier: staticSpecifier, clause: staticClause });
  }
  return imports;
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
    if (header) {
      const name = header[1];
      if (name === null || name === undefined) {
        section = null;
      } else {
        section = name;
      }
    } else if (line.startsWith("[")) {
      section = null;
    } else if (section && /^verify_jwt\s*=\s*false\b/.test(line)) {
      open.push(section);
    }
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
    if (seen.has(href)) {
      continue;
    }
    seen.add(href);
    const source = Deno.readTextFileSync(new URL(href));
    for (const moduleImport of importsOf(source)) {
      const specifier = moduleImport.specifier;
      const clause = moduleImport.clause;
      if (!specifier.startsWith(".")) {
        continue;
      }
      const target = new URL(specifier, href).href;
      if (target === sharedAuth && exposesIsServiceRole(clause)) {
        found.push(href);
      }
      queue.push(target);
    }
  }
  return found;
}

Deno.test("the isServiceRole check recognizes every way to reach it", function (): void {
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

Deno.test("the import walker sees side-effect, re-export and dynamic imports", function (): void {
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

Deno.test("the isServiceRole check finds the functions that use it", function (): void {
  for (const fn of ["archive", "import-cty", "import-iota"]) {
    assertEquals(modulesUsingIsServiceRole(fn).length > 0, true, `${fn} uses isServiceRole`);
  }
});

Deno.test("no verify_jwt = false function imports isServiceRole", function (): void {
  const open = functionsWithoutJwt();
  for (
    const fn of [
      "sign-in",
      "ingest-rbn",
      "callsign-profile",
      "band-map",
      "group-page",
      "load-references",
      "reference-profile",
      "reference-search",
      "spotted-activations",
      "relay-api",
    ]
  ) {
    assertEquals(open.includes(fn), true, `config.toml lists ${fn} with verify_jwt = false`);
  }
  const offenders = open.flatMap((fn) => modulesUsingIsServiceRole(fn).map((m) => `${fn}: ${m}`));
  assertEquals(offenders, [], "verify_jwt = false functions reaching isServiceRole");
});
