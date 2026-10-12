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
