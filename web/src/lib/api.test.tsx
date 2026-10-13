import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data?: unknown; error?: { message: string; code?: string } | null };

// A stand-in for the supabase-js client. Query builders are real promises with
// the chain methods attached, so `await supabase.from(...).select(...)` works.
const fake = vi.hoisted(() => {
  const tables = new Map<string, Result>();
  const rpcs = new Map<string, Result>();
  const ops: Array<[string, string, unknown[]]> = [];
  const settle = (r: Result | undefined) => ({ data: r?.data ?? null, error: r?.error ?? null });
  const builder = (table: string) => {
    const b = Object.assign(Promise.resolve(settle(tables.get(table))), {} as Record<string, (...a: unknown[]) => unknown>);
    for (const m of ["select", "eq", "order", "limit", "update", "delete", "single", "maybeSingle"]) {
      b[m] = (...a: unknown[]) => {
        ops.push([table, m, a]);
        return b;
      };
    }
    return b;
  };
  const client = {
    from: (table: string) => builder(table),
    rpc: vi.fn((fn: string, _args?: unknown) => Promise.resolve(settle(rpcs.get(fn)))),
    auth: {
      setSession: vi.fn(() => Promise.resolve({ error: null as { message: string } | null })),
      getSession: vi.fn(() => Promise.resolve({ data: { session: { access_token: "jwt" } as { access_token: string } | null } })),
      signUp: vi.fn(() => Promise.resolve({ error: null as Result["error"] })),
      resetPasswordForEmail: vi.fn(() => Promise.resolve({ error: null as Result["error"] })),
      updateUser: vi.fn(() => Promise.resolve({ error: null as Result["error"] })),
      signOut: vi.fn(() => Promise.resolve({ error: null as Result["error"] })),
    },
  };
  return { tables, rpcs, ops, client };
});

vi.mock("../supabase", () => ({
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  supabase: fake.client,
}));

const api = await import("./api");
const boom = { message: "boom", code: "XX000" };

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  fake.tables.clear();
  fake.rpcs.clear();
  fake.ops.length = 0;
  vi.unstubAllGlobals();
});

describe("Edge Function calls", () => {
  it("signIn posts the credentials and stores the returned session", async () => {
    const fetchMock = respond(200, { access_token: "a", refresh_token: "r" });
    await api.signIn("kk4pwj", "pw");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/sign-in");
    expect(init.headers).toEqual({ "Content-Type": "application/json", apikey: "anon-key" });
    expect(JSON.parse(init.body as string)).toEqual({ identifier: "kk4pwj", password: "pw" });
    expect(fake.client.auth.setSession).toHaveBeenCalledWith({ access_token: "a", refresh_token: "r" });
  });

  it("signIn surfaces a session error", async () => {
    respond(200, { access_token: "a", refresh_token: "r" });
    fake.client.auth.setSession.mockResolvedValueOnce({ error: { message: "bad session" } });
    await expect(api.signIn("x", "y")).rejects.toThrow("bad session");
  });

  it("surfaces the function's error message and status", async () => {
    respond(401, { error: "That callsign or email and password don't match." });
    await expect(api.verifyPassword("a@b.c", "pw")).rejects.toMatchObject({
      message: "That callsign or email and password don't match.",
      code: "401",
    });
  });

  it("falls back to the HTTP status when the body is not JSON", async () => {
    respond(502, "Bad gateway");
    await expect(api.verifyPassword("a@b.c", "pw")).rejects.toThrow("Request failed (HTTP 502).");
  });

  it("reports network failures in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.verifyPassword("a@b.c", "pw")).rejects.toThrow(/Couldn't reach Long Lines/);
  });

  it("sendTest and deleteAccount send the access token", async () => {
    const fetchMock = respond(200, { ok: true });
    await api.sendTest("d1");
    await api.deleteAccount();
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([u]) => u)).toEqual([
      "https://proj.supabase.co/functions/v1/send-test",
      "https://proj.supabase.co/functions/v1/delete-account",
    ]);
    expect((calls[0]![1].headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ destination_id: "d1" });
  });

  it("asks the user to sign in again without a session", async () => {
    respond(200, {});
    fake.client.auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    await expect(api.sendTest("d1")).rejects.toThrow("Sign in again.");
  });
});

describe("auth wrappers", () => {
  it("callsignAvailable is true only for a literal true", async () => {
    fake.rpcs.set("callsign_available", { data: true });
    expect(await api.callsignAvailable("KK4PWJ")).toBe(true);
    fake.rpcs.set("callsign_available", { data: false });
    expect(await api.callsignAvailable("KK4PWJ")).toBe(false);
    fake.rpcs.set("callsign_available", { error: boom });
    await expect(api.callsignAvailable("KK4PWJ")).rejects.toThrow("boom");
  });

  it("signUp passes callsign and name as user metadata", async () => {
    await api.signUp({ callsign: "KK4PWJ", name: "Brad", email: "a@b.c", password: "pw" });
    expect(fake.client.auth.signUp).toHaveBeenCalledWith({
      email: "a@b.c",
      password: "pw",
      options: { data: { callsign: "KK4PWJ", name: "Brad" } },
    });
  });

  it("requestPasswordReset sends users back to /set-password", async () => {
    await api.requestPasswordReset("a@b.c");
    expect(fake.client.auth.resetPasswordForEmail).toHaveBeenCalledWith("a@b.c", {
      redirectTo: `${window.location.origin}/set-password`,
    });
  });

  it("each wrapper turns a Supabase error into an ApiError with a fallback message", async () => {
    const auth = fake.client.auth;
    auth.signUp.mockResolvedValueOnce({ error: { message: "" } });
    await expect(api.signUp({ callsign: "A1A", name: "", email: "", password: "" })).rejects.toThrow(
      "Couldn't create your account.",
    );
    auth.resetPasswordForEmail.mockResolvedValueOnce({ error: boom });
    await expect(api.requestPasswordReset("a@b.c")).rejects.toBeInstanceOf(api.ApiError);
    auth.updateUser.mockResolvedValueOnce({ error: boom }).mockResolvedValueOnce({ error: boom });
    await expect(api.updatePassword("x")).rejects.toThrow("boom");
    await expect(api.updateEmail("x")).rejects.toThrow("boom");
    auth.signOut.mockResolvedValueOnce({ error: boom });
    await expect(api.signOut("others")).rejects.toThrow("boom");
  });

  it("updatePassword, updateEmail and signOut call through", async () => {
    await api.updatePassword("newpass1");
    await api.updateEmail("new@b.c");
    await api.signOut();
    expect(fake.client.auth.updateUser).toHaveBeenCalledWith({ password: "newpass1" });
    expect(fake.client.auth.updateUser).toHaveBeenCalledWith({ email: "new@b.c" });
    expect(fake.client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("profile", () => {
  it("loads the signed-in user's profile", async () => {
    fake.tables.set("profiles", { data: { id: "u1" } });
    expect(await api.loadProfile("u1")).toEqual({ id: "u1" });
    expect(fake.ops).toContainEqual(["profiles", "eq", ["id", "u1"]]);
  });

  it("maps a unique violation to a taken callsign", async () => {
    const patch = { callsign: "W1AW", name: "", timezone: "UTC", utc_times: true };
    fake.tables.set("profiles", { error: { message: "dup", code: "23505" } });
    await expect(api.updateProfile("u1", patch)).rejects.toThrow("That callsign is already taken.");
    fake.tables.set("profiles", { error: boom });
    await expect(api.updateProfile("u1", patch)).rejects.toThrow("boom");
    fake.tables.set("profiles", {});
    await expect(api.updateProfile("u1", patch)).resolves.toBeUndefined();
    await expect(api.loadProfile("u1")).resolves.toBeNull();
  });

  it("loadProfile rejects on error", async () => {
    fake.tables.set("profiles", { error: { message: "" } });
    await expect(api.loadProfile("u1")).rejects.toThrow("Couldn't load your profile.");
  });
});

describe("sources and destinations", () => {
  it("loads health and recent spots through their definer RPCs", async () => {
    fake.rpcs.set("list_ingest_health", { data: [{ source: "pota" }] });
    fake.rpcs.set("list_recent_spots", { data: [{ id: 1 }] });
    expect(await api.loadIngestHealth()).toEqual([{ source: "pota" }]);
    expect(await api.loadRecentSpots("sotawatch", 5)).toEqual([{ id: 1 }]);
    expect(fake.client.rpc).toHaveBeenCalledWith("list_recent_spots", { p_source: "sotawatch", max_rows: 5 });
    await api.loadRecentSpots("rbn");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("list_recent_spots", { p_source: "rbn", max_rows: 100 });
  });

  it("load functions reject on error", async () => {
    fake.rpcs.set("list_ingest_health", { error: boom });
    fake.rpcs.set("list_recent_spots", { error: boom });
    fake.tables.set("destinations", { error: boom });
    await expect(api.loadIngestHealth()).rejects.toThrow("boom");
    await expect(api.loadRecentSpots("pota")).rejects.toThrow("boom");
    await expect(api.loadDestinations()).rejects.toThrow("boom");
  });

  it("selects destinations without the secret columns", async () => {
    fake.tables.set("destinations", { data: [] });
    await api.loadDestinations();
    const select = fake.ops.find(([t, m]) => t === "destinations" && m === "select");
    expect(select?.[2][0]).toBe(api.DESTINATION_COLUMNS);
    expect(api.DESTINATION_COLUMNS).not.toMatch(/signing_secret|\burl\b/);
  });

  it("createDestination returns the created row or fails", async () => {
    const row = { id: "d1", type: "webhook", name: "n", url_display: "x", signing_secret: "s" };
    fake.rpcs.set("create_destination", { data: [row] });
    expect(await api.createDestination("webhook", "n", "https://x")).toEqual(row);
    fake.rpcs.set("create_destination", { data: [] });
    await expect(api.createDestination("webhook", "n", "https://x")).rejects.toThrow("Couldn't add the destination.");
    fake.rpcs.set("create_destination", { error: boom });
    await expect(api.createDestination("webhook", "n", "https://x")).rejects.toThrow("boom");
  });

  it("rotateSigningSecret returns the new secret", async () => {
    fake.rpcs.set("rotate_signing_secret", { data: "whsec_new" });
    expect(await api.rotateSigningSecret("d1")).toBe("whsec_new");
    fake.rpcs.set("rotate_signing_secret", { error: boom });
    await expect(api.rotateSigningSecret("d1")).rejects.toThrow("boom");
  });

  it("deleteDestination explains a foreign-key violation", async () => {
    fake.tables.set("destinations", {});
    await expect(api.deleteDestination("d1")).resolves.toBeUndefined();
    fake.tables.set("destinations", { error: { message: "fk", code: "23503" } });
    await expect(api.deleteDestination("d1")).rejects.toThrow("Remove it from its subscriptions first.");
    fake.tables.set("destinations", { error: boom });
    await expect(api.deleteDestination("d1")).rejects.toThrow("boom");
  });
});

describe("API tokens", () => {
  it("loadApiTokens selects every column but the hash", async () => {
    fake.tables.set("api_tokens", { data: [{ id: "t1" }] });
    expect(await api.loadApiTokens()).toEqual([{ id: "t1" }]);
    expect(fake.ops).toContainEqual(["api_tokens", "select", [api.API_TOKEN_COLUMNS]]);
    expect(api.API_TOKEN_COLUMNS).not.toContain("token_hash");
    fake.tables.set("api_tokens", { error: boom });
    await expect(api.loadApiTokens()).rejects.toThrow("boom");
  });

  it("createApiToken returns the secret and omits a missing lifetime", async () => {
    fake.rpcs.set("create_api_token", { data: [{ token: "ll_x" }] });
    expect(await api.createApiToken("Sync", "write", 30)).toBe("ll_x");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("create_api_token", { p_name: "Sync", p_scope: "write", p_lifetime_days: 30 });
    await api.createApiToken("Board", "read", null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("create_api_token", { p_name: "Board", p_scope: "read" });
    fake.rpcs.set("create_api_token", { data: [] });
    await expect(api.createApiToken("x", "read", null)).rejects.toThrow("Couldn't create the token.");
    fake.rpcs.set("create_api_token", { error: boom });
    await expect(api.createApiToken("x", "read", null)).rejects.toThrow("boom");
  });

  it("rotateApiToken returns the new secret", async () => {
    fake.rpcs.set("rotate_api_token", { data: [{ token: "ll_new" }] });
    expect(await api.rotateApiToken("t1")).toBe("ll_new");
    fake.rpcs.set("rotate_api_token", { data: [] });
    await expect(api.rotateApiToken("t1")).rejects.toThrow("Couldn't rotate the token.");
    fake.rpcs.set("rotate_api_token", { error: boom });
    await expect(api.rotateApiToken("t1")).rejects.toThrow("boom");
  });

  it("deleteApiToken deletes by id", async () => {
    fake.tables.set("api_tokens", {});
    await expect(api.deleteApiToken("t1")).resolves.toBeUndefined();
    expect(fake.ops).toContainEqual(["api_tokens", "eq", ["id", "t1"]]);
    fake.tables.set("api_tokens", { error: boom });
    await expect(api.deleteApiToken("t1")).rejects.toThrow("boom");
  });
});

describe("subscriptions", () => {
  it("joins each subscription with its destination ids", async () => {
    fake.tables.set("subscriptions", { data: [{ id: "s1" }, { id: "s2" }] });
    fake.tables.set("subscription_destinations", {
      data: [
        { subscription_id: "s1", destination_id: "d1" },
        { subscription_id: "s1", destination_id: "d2" },
      ],
    });
    expect(await api.loadSubscriptions()).toEqual([
      { id: "s1", destinations: ["d1", "d2"] },
      { id: "s2", destinations: [] },
    ]);
  });

  it("loadSubscriptions rejects when either query fails", async () => {
    fake.tables.set("subscriptions", { error: boom });
    fake.tables.set("subscription_destinations", { data: [] });
    await expect(api.loadSubscriptions()).rejects.toThrow("boom");
    fake.tables.set("subscriptions", { data: [] });
    fake.tables.set("subscription_destinations", { error: { message: "links" } });
    await expect(api.loadSubscriptions()).rejects.toThrow("links");
  });

  const input = {
    name: "NC", enabled: true, sources: [], bands: [], modes: [], callsigns: [], reference: "", quiet_minutes: 0, destinations: ["d1"],
  };

  it("save, delete and enable go through their RPCs and table", async () => {
    fake.rpcs.set("save_subscription", { data: "s1" });
    expect(await api.saveSubscription(input)).toBe("s1");
    expect(fake.client.rpc).toHaveBeenCalledWith("save_subscription", { payload: input });
    await api.deleteSubscription("s1");
    expect(fake.client.rpc).toHaveBeenCalledWith("delete_subscription", { p_id: "s1" });
    await api.setSubscriptionEnabled("s1", false);
    expect(fake.ops).toContainEqual(["subscriptions", "update", [{ enabled: false }]]);
  });

  it("save, delete and enable reject on error", async () => {
    fake.rpcs.set("save_subscription", { error: boom });
    fake.rpcs.set("delete_subscription", { error: boom });
    fake.tables.set("subscriptions", { error: boom });
    await expect(api.saveSubscription(input)).rejects.toThrow("boom");
    await expect(api.deleteSubscription("s1")).rejects.toThrow("boom");
    await expect(api.setSubscriptionEnabled("s1", true)).rejects.toThrow("boom");
  });

  it("previewSubscription normalizes the RPC row", async () => {
    fake.rpcs.set("preview_subscription", { data: [{ count: "7", spots: [{ id: 1 }] }] });
    expect(await api.previewSubscription(input)).toEqual({ count: 7, spots: [{ id: 1 }] });
    fake.rpcs.set("preview_subscription", { data: [] });
    expect(await api.previewSubscription(input)).toEqual({ count: 0, spots: [] });
    fake.rpcs.set("preview_subscription", { error: boom });
    await expect(api.previewSubscription(input)).rejects.toThrow("boom");
  });
});

describe("callsign groups", () => {
  const latest = {
    callsign: "KK4PWJ/P", frequency_khz: 14062, band: "20m", mode: "CW", source: "pota", reference: "US-2763",
    spot_time: "2026-10-13T14:00:00Z",
  };

  it("listGroups returns the RPC rows with numeric counts", async () => {
    fake.rpcs.set("list_callsign_groups", {
      data: [{
        id: "g1", name: "RARS", callsigns: ["KK4PWJ"], member_count: "1", subscription_count: "2", updated_at: "x",
        on_air: { count: 1, latest },
      }],
    });
    expect(await api.listGroups()).toEqual([{
      id: "g1", name: "RARS", callsigns: ["KK4PWJ"], member_count: 1, subscription_count: 2, updated_at: "x",
      on_air: { count: 1, latest },
    }]);
    fake.rpcs.set("list_callsign_groups", { error: boom });
    await expect(api.listGroups()).rejects.toThrow("boom");
  });

  it("saveGroup sends the whole list and returns the id", async () => {
    fake.rpcs.set("save_callsign_group", { data: "g1" });
    expect(await api.saveGroup({ name: "RARS", callsigns: ["KK4PWJ"] })).toBe("g1");
    expect(fake.client.rpc).toHaveBeenCalledWith("save_callsign_group", { payload: { name: "RARS", callsigns: ["KK4PWJ"] } });
    await api.saveGroup({ id: "g1", name: "RARS", callsigns: [] });
    expect(fake.client.rpc).toHaveBeenCalledWith("save_callsign_group", { payload: { id: "g1", name: "RARS", callsigns: [] } });
    fake.rpcs.set("save_callsign_group", { error: { message: "You already have a group with that name." } });
    await expect(api.saveGroup({ name: "RARS", callsigns: [] })).rejects.toThrow("You already have a group with that name.");
  });

  it("deleteGroup goes through its RPC", async () => {
    await api.deleteGroup("g1");
    expect(fake.client.rpc).toHaveBeenCalledWith("delete_callsign_group", { p_id: "g1" });
    fake.rpcs.set("delete_callsign_group", { error: { message: "Remove it from its subscriptions first." } });
    await expect(api.deleteGroup("g1")).rejects.toThrow("Remove it from its subscriptions first.");
  });

  it("normalizeCallsigns returns the server's base calls and rejections", async () => {
    fake.rpcs.set("normalize_group_callsigns", { data: { callsigns: ["KK4PWJ"], rejected: ["NOPE"] } });
    expect(await api.normalizeCallsigns(["kk4pwj/p", "nope"])).toEqual({ callsigns: ["KK4PWJ"], rejected: ["NOPE"] });
    expect(fake.client.rpc).toHaveBeenCalledWith("normalize_group_callsigns", { p_calls: ["kk4pwj/p", "nope"] });
    fake.rpcs.set("normalize_group_callsigns", { error: boom });
    await expect(api.normalizeCallsigns(["x"])).rejects.toThrow("boom");
  });
});

describe("stats", () => {
  it("returns the newest snapshot, or null before the first refresh", async () => {
    fake.tables.set("stats_snapshots", { data: { payload: { totals: {} }, generated_at: "2026-10-05T13:00:00Z" } });
    expect(await api.loadLatestStats()).toEqual({ payload: { totals: {} }, generatedAt: "2026-10-05T13:00:00Z" });
    fake.tables.set("stats_snapshots", { data: null });
    expect(await api.loadLatestStats()).toBeNull();
    fake.tables.set("stats_snapshots", { error: boom });
    await expect(api.loadLatestStats()).rejects.toThrow("boom");
  });
});

describe("callsign profiles", () => {
  it("GETs the profile function with the callsign as typed and no session", async () => {
    fake.client.auth.getSession.mockClear();
    const fetchMock = respond(200, { callsign: "KK4PWJ" });
    expect(await api.loadCallsignProfile("KK4PWJ/P")).toEqual({ callsign: "KK4PWJ" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/callsign-profile?callsign=KK4PWJ%2FP");
    expect(init).toEqual({ headers: { apikey: "anon-key" } });
    expect(fake.client.auth.getSession).not.toHaveBeenCalled();
  });

  it("rejects invalid input and the rate limit with the function's message and status", async () => {
    respond(400, { error: "Enter a callsign, like KK4PWJ." });
    await expect(api.loadCallsignProfile("BOGUS")).rejects.toMatchObject({ message: "Enter a callsign, like KK4PWJ.", code: "400" });
    respond(429, { error: "Too many lookups. Try again in a minute." });
    await expect(api.loadCallsignProfile("W1AW")).rejects.toMatchObject({ code: "429" });
  });
});
