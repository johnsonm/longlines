import { assertEquals, assertMatch } from "@std/assert";
import { handleImportCty } from "../handlers/import_cty.ts";
import { fakeSupabase } from "./fake_supabase.ts";

const KEY = "service-key";
const fixture = Deno.readTextFileSync(new URL("./fixtures/cty.dat", import.meta.url));

function req(token?: string): Request {
  const init: RequestInit = { method: "POST", headers: {} };
  if (token) {
    init.headers = { Authorization: `Bearer ${token}` };
  }
  return new Request("http://x/import-cty", init);
}

// Rejects with whatever it is given, so a test can reject with a non-Error.
async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

Deno.test(
  "handleImportCty refuses callers without the service-role key",
  async function (): Promise<void> {
    const fake = fakeSupabase();
    const client = fake.client;
    let fetched = 0;
    function fetchCty(): Promise<string> {
      fetched++;
      return Promise.resolve(fixture);
    }
    const deps = {
      serviceRoleKey: KEY,
      db: () => client,
      fetchCty,
    };
    for (const token of [undefined, "anon-key"]) {
      assertEquals((await handleImportCty(req(token), deps)).status, 403);
    }
    assertEquals(fetched, 0);
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleImportCty loads the parsed file through load_cty",
  async function (): Promise<void> {
    const fake = fakeSupabase({ rpc: { load_cty: { data: null } } });
    const client = fake.client;
    const calls = fake.calls;
    const res = await handleImportCty(req(KEY), {
      serviceRoleKey: KEY,
      db: () => client,
      fetchCty: () => Promise.resolve(fixture),
    });
    assertEquals(res.status, 200);
    let timing = res.headers.get("Server-Timing");
    if (timing === null) {
      timing = "";
    }
    assertMatch(timing, /^total;dur=\d+\.\d$/);
    const body = await res.json();
    assertEquals([body.version, body.entities], ["20260915", 340]);
    assertEquals(calls.rpc.map((c) => c.fn), ["load_cty"]);
    const first = calls.rpc[0];
    let args: Record<string, unknown> = {};
    if (first !== undefined && first.args !== undefined) {
      args = first.args;
    }
    assertEquals(args["p_version"], "20260915");
    assertEquals((args["p_entities"] as unknown[]).length, 340);
    assertEquals((args["p_prefixes"] as unknown[]).length, body.prefixes);
  },
);

Deno.test(
  "handleImportCty answers 500 and loads nothing when the file is short or broken",
  async function (): Promise<void> {
    const short = "Somewhere: 1: 2: EU: 0: 0: 0: XX:\r\n    XX;\r\n";
    for (const text of [short, "<html>Not Found</html>"]) {
      const fake = fakeSupabase();
      const client = fake.client;
      const res = await handleImportCty(req(KEY), {
        serviceRoleKey: KEY,
        db: () => client,
        fetchCty: () => Promise.resolve(text),
      });
      assertEquals(res.status, 500);
      assertEquals(fake.calls.rpc, []);
    }
  },
);

Deno.test(
  "handleImportCty answers 500 when the download or the load fails",
  async function (): Promise<void> {
    const down = fakeSupabase();
    const res = await handleImportCty(req(KEY), {
      serviceRoleKey: KEY,
      db: () => down.client,
      fetchCty: () => Promise.reject(new Error("GET cty.dat failed: HTTP 503")),
    });
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, "GET cty.dat failed: HTTP 503");

    const fake = fakeSupabase({ rpc: { load_cty: { error: { message: "boom" } } } });
    const client = fake.client;
    const failed = await handleImportCty(req(KEY), {
      serviceRoleKey: KEY,
      db: () => client,
      fetchCty: () => Promise.resolve(fixture),
    });
    assertEquals(failed.status, 500);
    assertEquals((await failed.json()).error, "load_cty failed: boom");
  },
);

Deno.test("handleImportCty reports a thrown non-Error as text", async function (): Promise<void> {
  const fake = fakeSupabase();
  const client = fake.client;
  const res = await handleImportCty(req(KEY), {
    serviceRoleKey: KEY,
    db: () => client,
    fetchCty: () => rejectWith("socket closed"),
  });
  assertEquals((await res.json()).error, "socket closed");
});
