import { assertEquals, assertMatch } from "@std/assert";
import { handleImportIota } from "../handlers/import_iota.ts";
import { fakeSupabase } from "./fake_supabase.ts";

const KEY = "service-key";

/** A full-size list: the import refuses fewer than 1,000 groups. */
function groups(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    refno: `${["AF", "AN", "AS", "EU", "NA", "OC", "SA"][i % 7]}-${
      String(100 + Math.floor(i / 7)).padStart(3, "0")
    }`,
    name: `Group ${String(i)}`,
    dxcc_num: "1",
  }));
}

function req(token: string | undefined): Request {
  const init: RequestInit = { method: "POST", headers: {} };
  if (token) {
    init.headers = { Authorization: `Bearer ${token}` };
  }
  return new Request("http://x/import-iota", init);
}

// Rejects with whatever it is given, so a test can reject with a non-Error.
async function rejectWith(reason: unknown): Promise<never> {
  await Promise.resolve();
  throw reason;
}

Deno.test(
  "handleImportIota refuses callers without the service-role key",
  async function (): Promise<void> {
    const fake = fakeSupabase({});
    const client = fake.client;
    let fetched = 0;
    function fetchGroups(): Promise<unknown> {
      fetched++;
      return Promise.resolve(groups(1200));
    }
    for (const token of [undefined, "anon-key"]) {
      const res = await handleImportIota(req(token), {
        serviceRoleKey: KEY,
        cronSecret: undefined,
        db: () => client,
        fetchGroups,
      });
      assertEquals(res.status, 403);
    }
    assertEquals(fetched, 0);
    assertEquals(fake.calls.rpc, []);
  },
);

Deno.test(
  "handleImportIota loads the parsed groups through load_iota_groups",
  async function (): Promise<void> {
    const fake = fakeSupabase({ rpc: { load_iota_groups: { data: 1200 } } });
    const client = fake.client;
    const calls = fake.calls;
    const res = await handleImportIota(req(KEY), {
      serviceRoleKey: KEY,
      cronSecret: undefined,
      db: () => client,
      fetchGroups: () => Promise.resolve(groups(1200)),
    });
    assertEquals(res.status, 200);
    let timing = res.headers.get("Server-Timing");
    if (timing === null) {
      timing = "";
    }
    assertMatch(timing, /^total;dur=\d+\.\d$/);
    assertEquals(await res.json(), { groups: 1200 });
    assertEquals(calls.rpc.map((c) => c.fn), ["load_iota_groups"]);
    const first = calls.rpc[0];
    let args: Record<string, unknown> = {};
    if (first !== undefined && first.args !== undefined) {
      args = first.args;
    }
    const sent = args["p_groups"] as { refno: string; name: string }[];
    assertEquals(sent.length, 1200);
    // Only the two kept fields.
    assertEquals(sent[0], { refno: "AF-100", name: "Group 0" });
  },
);

Deno.test(
  "handleImportIota answers 500 and loads nothing when the file is short or broken",
  async function (): Promise<void> {
    for (const body of [groups(999), [{ refno: "nope", name: "x" }], "<html>Not Found</html>"]) {
      const fake = fakeSupabase({});
      const client = fake.client;
      const res = await handleImportIota(req(KEY), {
        serviceRoleKey: KEY,
        cronSecret: undefined,
        db: () => client,
        fetchGroups: () => Promise.resolve(body),
      });
      assertEquals(res.status, 500);
      assertEquals(fake.calls.rpc, []);
    }
  },
);

Deno.test(
  "handleImportIota answers 500 when the download, the load or its result fails",
  async function (): Promise<void> {
    const down = fakeSupabase({});
    const res = await handleImportIota(req(KEY), {
      serviceRoleKey: KEY,
      cronSecret: undefined,
      db: () => down.client,
      fetchGroups: () => Promise.reject(new Error("GET groups.json failed: HTTP 503")),
    });
    assertEquals(res.status, 500);
    assertEquals((await res.json()).error, "GET groups.json failed: HTTP 503");

    const fake = fakeSupabase({ rpc: { load_iota_groups: { error: { message: "boom" } } } });
    const failed = await handleImportIota(req(KEY), {
      serviceRoleKey: KEY,
      cronSecret: undefined,
      db: () => fake.client,
      fetchGroups: () => Promise.resolve(groups(1200)),
    });
    assertEquals(failed.status, 500);
    assertEquals((await failed.json()).error, "load_iota_groups failed: boom");

    const odd = fakeSupabase({ rpc: { load_iota_groups: { data: "lots" } } });
    const unread = await handleImportIota(req(KEY), {
      serviceRoleKey: KEY,
      cronSecret: undefined,
      db: () => odd.client,
      fetchGroups: () => Promise.resolve(groups(1200)),
    });
    assertEquals(unread.status, 500);
  },
);

Deno.test("handleImportIota reports a thrown non-Error as text", async function (): Promise<void> {
  const fake = fakeSupabase({});
  const res = await handleImportIota(req(KEY), {
    serviceRoleKey: KEY,
    cronSecret: undefined,
    db: () => fake.client,
    fetchGroups: () => rejectWith("socket closed"),
  });
  assertEquals((await res.json()).error, "socket closed");
});
