import { assertEquals } from "@std/assert";

// The inbound worker and sender images run with their app's deno.json as the only
// config (`--config /deno.json`); the root deno.json and deno.lock that tests
// and `deno task check` use are not in the image. A package mapped there but
// not in the app's file fails to resolve on Fly, and one mapped to another
// version runs code CI never tested.

const repo = new URL("../../../../", import.meta.url);
const root = JSON.parse(Deno.readTextFileSync(new URL("deno.json", repo)));

function appConfig(app: string) {
  return JSON.parse(Deno.readTextFileSync(new URL(`${app}/deno.json`, repo)));
}

Deno.test(
  "the inbound worker's and the sender's deno.json map every package like the root one",
  function (): void {
    for (const app of ["inbound", "sender"]) {
      const config = appConfig(app);
      assertEquals(Object.keys(config), ["imports"], `${app}/deno.json holds only an import map`);
      for (const entry of Object.entries(config.imports)) {
        const name = entry[0];
        const specifier = entry[1];
        assertEquals(specifier, root.imports[name], `${app}/deno.json maps ${name} differently`);
        // The image has no deno.lock, so only an exact version pins what it runs.
        assertEquals(
          /@\d+\.\d+\.\d+$/.test(String(specifier)),
          true,
          `${app}/deno.json maps ${name} to a range`,
        );
      }
    }
  },
);

Deno.test("the sender's deno.json maps postgres (sender/db.ts)", function (): void {
  assertEquals("postgres" in appConfig("sender").imports, true);
});

// Zod validates external data (_shared/validate.ts), which both apps will load.
Deno.test("the inbound worker's and the sender's deno.json map zod", function (): void {
  for (const app of ["inbound", "sender"]) {
    assertEquals("zod" in appConfig(app).imports, true, `${app}/deno.json maps zod`);
  }
});
