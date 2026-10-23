import { assertEquals } from "@std/assert";
import { handleDeleteAccount } from "../handlers/delete_account.ts";
import { fakeSupabase, type FakeSupabaseOptions } from "./fake_supabase.ts";

function post(token: string | null = "jwt"): Request {
  const headers: Record<string, string> = {};
  if (token !== null && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request("http://x/", { method: "POST", headers });
}

async function run(req: Request, options: FakeSupabaseOptions = {}) {
  const fakeOptions: FakeSupabaseOptions = { getUser: { data: { user: { id: "u1" } } } };
  Object.assign(fakeOptions, options);
  const fake = fakeSupabase(fakeOptions);
  const client = fake.client;
  const res = await handleDeleteAccount(req, { admin: () => client });
  let body = null;
  if (res.status !== 204) {
    body = await res.json();
  }
  return { res, body, calls: fake.calls };
}

Deno.test(
  "handleDeleteAccount answers preflight and rejects other methods",
  async function (): Promise<void> {
    assertEquals((await run(new Request("http://x/", { method: "OPTIONS" }))).res.status, 204);
    assertEquals((await run(new Request("http://x/"))).res.status, 405);
  },
);

Deno.test("handleDeleteAccount requires a signed-in user", async function (): Promise<void> {
  const ran = await run(post(null));
  const res = ran.res;
  const calls = ran.calls;
  assertEquals(res.status, 401);
  assertEquals(calls.deleteUser, []);
});

Deno.test("handleDeleteAccount deletes the caller", async function (): Promise<void> {
  const ran = await run(post());
  const res = ran.res;
  const body = ran.body;
  const calls = ran.calls;
  assertEquals(res.status, 200);
  assertEquals(body, { ok: true });
  assertEquals(calls.deleteUser, ["u1"]);
});

Deno.test("handleDeleteAccount returns 500 when Auth refuses", async function (): Promise<void> {
  const ran = await run(post(), { deleteUser: { error: { message: "nope" } } });
  const res = ran.res;
  const body = ran.body;
  assertEquals(res.status, 500);
  assertEquals(body, { error: "Couldn't delete your account. Try again." });
});
