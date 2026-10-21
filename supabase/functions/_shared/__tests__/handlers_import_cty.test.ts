import { assertEquals, assertMatch } from "@std/assert";
import { handleImportCty } from "../handlers/import_cty.ts";
import { fakeSupabase } from "./fake_supabase.ts";

const KEY = "service-key";
const fixture = Deno.readTextFileSync(new URL("./fixtures/cty.dat", import.meta.url));
const req = (token?: string) =>
  new Request("http://x/import-cty", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

Deno.test("handleImportCty refuses callers without the service-role key", async () => {
  const { client, calls } = fakeSupabase();
  let fetched = 0;
  const deps = {
    serviceRoleKey: KEY,
    db: () => client,
    fetchCty: () => {
      fetched++;
      return Promise.resolve(fixture);
    },
  };
  for (const token of [undefined, "anon-key"]) {
    assertEquals((await handleImportCty(req(token), deps)).status, 403);
  }
  assertEquals(fetched, 0);
  assertEquals(calls.rpc, []);
});

Deno.test("handleImportCty loads the parsed file through load_cty", async () => {
  const { client, calls } = fakeSupabase({ rpc: { load_cty: { data: null } } });
  const res = await handleImportCty(req(KEY), {
    serviceRoleKey: KEY,
    db: () => client,
    fetchCty: () => Promise.resolve(fixture),
  });
  assertEquals(res.status, 200);
  assertMatch(res.headers.get("Server-Timing") ?? "", /^total;dur=\d+\.\d$/);
  const body = await res.json();
  assertEquals([body.version, body.entities], ["20260915", 340]);
  assertEquals(calls.rpc.map((c) => c.fn), ["load_cty"]);
  const args = calls.rpc[0]?.args ?? {};
  assertEquals(args["p_version"], "20260915");
  assertEquals((args["p_entities"] as unknown[]).length, 340);
  assertEquals((args["p_prefixes"] as unknown[]).length, body.prefixes);
});

Deno.test("handleImportCty answers 500 and loads nothing when the file is short or broken", async () => {
  const short = "Somewhere: 1: 2: EU: 0: 0: 0: XX:\r\n    XX;\r\n";
  for (const text of [short, "<html>Not Found</html>"]) {
    const { client, calls } = fakeSupabase();
    const res = await handleImportCty(req(KEY), {
      serviceRoleKey: KEY,
      db: () => client,
      fetchCty: () => Promise.resolve(text),
    });
    assertEquals(res.status, 500);
    assertEquals(calls.rpc, []);
  }
});

Deno.test("handleImportCty answers 500 when the download or the load fails", async () => {
  const down = fakeSupabase();
  const res = await handleImportCty(req(KEY), {
    serviceRoleKey: KEY,
    db: () => down.client,
    fetchCty: () => Promise.reject(new Error("GET cty.dat failed: HTTP 503")),
  });
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "GET cty.dat failed: HTTP 503");

  const { client } = fakeSupabase({ rpc: { load_cty: { error: { message: "boom" } } } });
  const failed = await handleImportCty(req(KEY), {
    serviceRoleKey: KEY,
    db: () => client,
    fetchCty: () => Promise.resolve(fixture),
  });
  assertEquals(failed.status, 500);
  assertEquals((await failed.json()).error, "load_cty failed: boom");
});

Deno.test("handleImportCty reports a thrown non-Error as text", async () => {
  const { client } = fakeSupabase();
  const res = await handleImportCty(req(KEY), {
    serviceRoleKey: KEY,
    db: () => client,
    fetchCty: () => Promise.reject("socket closed"),
  });
  assertEquals((await res.json()).error, "socket closed");
});
