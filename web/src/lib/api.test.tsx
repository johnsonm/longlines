import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordSettings, LocalClusterSettings, PushSettings, WebhookSettings } from "./api";

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
      signInWithOAuth: vi.fn(() => Promise.resolve({ error: null as Result["error"] })),
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

  it("verifyPassword revokes the session the check minted, scoped to that session", async () => {
    fake.client.auth.setSession.mockClear();
    const fetchMock = respond(200, { access_token: "checked", refresh_token: "r" });
    await api.verifyPassword("a@b.c", "pw");
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([u]) => u)).toEqual([
      "https://proj.supabase.co/functions/v1/sign-in",
      "https://proj.supabase.co/auth/v1/logout?scope=local",
    ]);
    expect(calls[1]![1]).toEqual({ method: "POST", headers: { apikey: "anon-key", Authorization: "Bearer checked" } });
    expect(fake.client.auth.setSession).not.toHaveBeenCalled();
  });

  it("verifyPassword still succeeds when the revoke fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "a", refresh_token: "r" }), { status: 200 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.verifyPassword("a@b.c", "pw")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the function's error message and status", async () => {
    respond(401, { error: "That email and password don't match." });
    await expect(api.verifyPassword("a@b.c", "pw")).rejects.toMatchObject({
      message: "That email and password don't match.",
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

  it("sendTest sends the chosen spot only when there is one", async () => {
    const fetchMock = respond(200, { ok: true });
    await api.sendTest("d1", 42);
    await api.sendTest("d1", null);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ destination_id: "d1", spot_id: 42 });
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ destination_id: "d1" });
  });

  it("sendTest returns a webhook receiver's status, or null when the answer has none", async () => {
    respond(200, { ok: true, status: 204 });
    expect(await api.sendTest("d1")).toEqual({ status: 204 });
    respond(200, { ok: true });
    expect(await api.sendTest("d1")).toEqual({ status: null });
    respond(502, { error: "Webhook HTTP 500", status: 500 });
    await expect(api.sendTest("d1")).rejects.toMatchObject({ message: "Webhook HTTP 500", code: "502", receiverStatus: 500 });
    respond(502, { error: "Webhook request failed: refused", status: "x" });
    await expect(api.sendTest("d1")).rejects.toMatchObject({ code: "502", receiverStatus: undefined });
  });
});

describe("auth wrappers", () => {
  it("signUp passes callsign and name as user metadata", async () => {
    await api.signUp({ callsign: "KK4PWJ", name: "Brad", email: "a@b.c", password: "pw" });
    expect(fake.client.auth.signUp).toHaveBeenCalledWith({
      email: "a@b.c",
      password: "pw",
      options: { data: { callsign: "KK4PWJ", name: "Brad" } },
    });
  });

  it("signInWithGoogle comes back to the site root", async () => {
    await api.signInWithGoogle();
    expect(fake.client.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: window.location.origin } });
    fake.client.auth.signInWithOAuth.mockResolvedValueOnce({ error: { message: "" } });
    await expect(api.signInWithGoogle()).rejects.toThrow("Couldn't sign in with Google.");
  });

  it("completeProfile calls complete_profile and surfaces its message", async () => {
    await api.completeProfile("KK4PWJ", "Brad");
    expect(fake.client.rpc).toHaveBeenCalledWith("complete_profile", { p_callsign: "KK4PWJ", p_name: "Brad" });
    fake.rpcs.set("complete_profile", { error: { message: "Your account is already set up.", code: "P0001" } });
    await expect(api.completeProfile("W1AW", "")).rejects.toThrow("Your account is already set up.");
    fake.rpcs.set("complete_profile", { error: { message: "" } });
    await expect(api.completeProfile("W1AW", "")).rejects.toThrow("Couldn't finish creating your account.");
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

  it("signOut runs the cleanup first and signs out even when it rejects", async () => {
    fake.client.auth.signOut.mockClear();
    const order: string[] = [];
    fake.client.auth.signOut.mockImplementationOnce(() => {
      order.push("signOut");
      return Promise.resolve({ error: null });
    });
    await api.signOut("local", () => {
      order.push("cleanup");
      return Promise.resolve();
    });
    expect(order).toEqual(["cleanup", "signOut"]);
    await api.signOut("local", () => Promise.reject(new Error("offline")));
    expect(fake.client.auth.signOut).toHaveBeenCalledTimes(2);
  });
});

describe("profile", () => {
  it("loads the signed-in user's profile", async () => {
    fake.tables.set("profiles", { data: { id: "u1" } });
    expect(await api.loadProfile("u1")).toEqual({ id: "u1" });
    expect(fake.ops).toContainEqual(["profiles", "eq", ["id", "u1"]]);
  });

  it("updates the profile and rejects on error", async () => {
    const patch = { callsign: "W1AW", name: "", timezone: "UTC", utc_times: true };
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
    expect(api.DESTINATION_COLUMNS).toMatch(/\benabled\b/);
    expect(api.DESTINATION_COLUMNS).toMatch(/\bauto_disabled_at\b/);
    expect(api.DESTINATION_COLUMNS).not.toMatch(/secret_rotated_at|pause_failure/);
  });

  it("rotateSigningSecret returns the new secret", async () => {
    fake.rpcs.set("rotate_signing_secret", { data: "whsec_new" });
    expect(await api.rotateSigningSecret("d1")).toBe("whsec_new");
    fake.rpcs.set("rotate_signing_secret", { error: boom });
    await expect(api.rotateSigningSecret("d1")).rejects.toThrow("boom");
  });

  it("deleteDestination deletes or fails", async () => {
    fake.tables.set("destinations", {});
    await expect(api.deleteDestination("d1")).resolves.toBeUndefined();
    fake.tables.set("destinations", { error: boom });
    await expect(api.deleteDestination("d1")).rejects.toThrow("boom");
  });
});

describe("push", () => {
  const keys = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "p256", auth: "auth16" };
  const settings: PushSettings = {
    title_fields: ["callsign", "frequency", "mode"], body_fields: ["source", "reference", "place_name", "state"],
    show_field_names: false, body_separator: "dot", tap_target: "profile", action_buttons: true, urgency: "normal", ttl_seconds: 1800,
    replace_same_station: true, sound: true, quiet_enabled: false, quiet_from: "22:00", quiet_until: "07:00", quiet_mode: "silent",
  };

  it("registerPushDevice sends the keys and the descriptor, or nulls to keep them", async () => {
    fake.rpcs.set("register_push_device", { data: "dev1" });
    expect(await api.registerPushDevice(keys, "My laptop", "Chrome on Linux", false)).toBe("dev1");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("register_push_device", {
      p_endpoint: keys.endpoint, p_p256dh: "p256", p_auth: "auth16", p_label: "My laptop", p_agent: "Chrome on Linux", p_standalone: false,
    });
    await api.registerPushDevice(keys, null, null, null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("register_push_device", expect.objectContaining({ p_label: null, p_agent: null, p_standalone: null }));
    await api.registerPushDevice(keys, null, null, null, "https://fcm.googleapis.com/fcm/send/old");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("register_push_device",
      expect.objectContaining({ p_endpoint: keys.endpoint, p_previous_endpoint: "https://fcm.googleapis.com/fcm/send/old" }));
    fake.rpcs.set("register_push_device", { error: { message: "" } });
    await expect(api.registerPushDevice(keys, "x", null, null)).rejects.toThrow("Couldn't turn on notifications.");
  });

  it("device RPCs pass their arguments through", async () => {
    await api.unregisterPushDevice(keys.endpoint);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("unregister_push_device", { p_endpoint: keys.endpoint });
    await api.deletePushDevice("dev1");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("delete_push_device", { p_id: "dev1" });
    await api.renamePushDevice("dev1", "Phone");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("rename_push_device", { p_id: "dev1", p_label: "Phone" });
    await api.reportPushDeviceBlocked(keys.endpoint);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("report_push_device_blocked", { p_endpoint: keys.endpoint });
    for (const name of ["unregister_push_device", "delete_push_device", "rename_push_device", "report_push_device_blocked"]) {
      fake.rpcs.set(name, { error: boom });
    }
    await expect(api.unregisterPushDevice("e")).rejects.toThrow("boom");
    await expect(api.deletePushDevice("d")).rejects.toThrow("boom");
    await expect(api.renamePushDevice("d", "x")).rejects.toThrow("boom");
    await expect(api.reportPushDeviceBlocked("e")).rejects.toThrow("boom");
  });

  it("listPushDevices marks the current endpoint only when there is one", async () => {
    const row = { id: "dev1", label: "Phone", agent: "Chrome on Android", standalone: true, created_at: "x", last_success_at: null,
      last_error: null, last_error_at: null, blocked_at: null, is_current: true, destination_ids: ["p1"] };
    fake.rpcs.set("list_push_devices", { data: [row] });
    expect(await api.listPushDevices(keys.endpoint)).toEqual([row]);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("list_push_devices", { p_current_endpoint: keys.endpoint });
    await api.listPushDevices(null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("list_push_devices", {});
    fake.rpcs.set("list_push_devices", { error: boom });
    await expect(api.listPushDevices(null)).rejects.toThrow("boom");
  });

  it("savePushDestination creates without an id and replaces with one", async () => {
    fake.rpcs.set("save_push_destination", { data: "p1" });
    expect(await api.savePushDestination({ name: "Phone", enabled: true, settings, device_ids: ["dev1"] })).toBe("p1");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_push_destination", {
      p_id: null, p_name: "Phone", p_enabled: true, p_settings: settings, p_device_ids: ["dev1"],
    });
    await api.savePushDestination({ id: "p1", name: "Phone", enabled: false, settings, device_ids: [] });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_push_destination", expect.objectContaining({ p_id: "p1", p_enabled: false, p_device_ids: [] }));
    fake.rpcs.set("save_push_destination", { error: { message: "A destination named Phone already exists. Choose a different name." } });
    await expect(api.savePushDestination({ name: "Phone", enabled: true, settings, device_ids: [] })).rejects.toThrow(/already exists/);
  });

  it("getPushDestination returns the RPC's json", async () => {
    const dest = { id: "p1", name: "Phone", enabled: true, settings, device_ids: ["dev1"] };
    fake.rpcs.set("get_push_destination", { data: dest });
    expect(await api.getPushDestination("p1")).toEqual(dest);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("get_push_destination", { p_id: "p1" });
    fake.rpcs.set("get_push_destination", { error: { message: "Destination not found." } });
    await expect(api.getPushDestination("p1")).rejects.toThrow("Destination not found.");
  });

  it("duplicateDestination returns the copy's id", async () => {
    fake.rpcs.set("duplicate_destination", { data: "p2" });
    expect(await api.duplicateDestination("p1")).toBe("p2");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("duplicate_destination", { p_id: "p1" });
    fake.rpcs.set("duplicate_destination", { error: boom });
    await expect(api.duplicateDestination("p1")).rejects.toThrow("boom");
  });

  it("previewPushNotification sends the picks and the spot, and returns the one row", async () => {
    const row = { title: "KK4PWJ · 14.062 MHz · CW", body: "POTA · US-2763", url: "https://longlines.io/call/KK4PWJ", source_url: null };
    fake.rpcs.set("preview_push_notification", { data: [row] });
    expect(await api.previewPushNotification(["callsign", "frequency", "mode"], ["source", "reference"], false, "dot", 42)).toEqual(row);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_push_notification", {
      p_title_fields: ["callsign", "frequency", "mode"], p_body_fields: ["source", "reference"], p_show_field_names: false,
      p_body_separator: "dot", p_spot_id: 42,
    });
    await api.previewPushNotification(["callsign"], [], true, "newline", null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_push_notification", {
      p_title_fields: ["callsign"], p_body_fields: [], p_show_field_names: true, p_body_separator: "newline",
    });
    fake.rpcs.set("preview_push_notification", { data: [] });
    await expect(api.previewPushNotification(["callsign"], [], false, "dot", null)).rejects.toThrow("Couldn't load the preview.");
    fake.rpcs.set("preview_push_notification", { error: { message: "Pick 1 to 4 fields for the title." } });
    await expect(api.previewPushNotification([], [], false, "dot", null)).rejects.toThrow("Pick 1 to 4 fields for the title.");
  });
});

describe("discord", () => {
  const settings: DiscordSettings = {
    style: "card", title_fields: ["callsign", "frequency", "mode"], detail_fields: ["source", "reference", "place_name", "state"],
    grid_fields: ["band", "spotter"], title_link: "profile", card_color: "source", footer: true,
    line_fields: ["callsign", "frequency", "mode", "source", "reference", "place_name"], bold_first: true, link_preview: "hidden",
    show_field_names: false, separator: "dot", batch_seconds: 0,
  };

  it("saveDiscordDestination creates without an id and updates with one, a null URL keeping the stored one", async () => {
    fake.rpcs.set("save_discord_destination", { data: "d1" });
    const url = "https://discord.com/api/webhooks/1/abc";
    expect(await api.saveDiscordDestination({ name: "Spots", enabled: true, url, settings })).toBe("d1");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_discord_destination", {
      p_id: null, p_name: "Spots", p_enabled: true, p_url: url, p_settings: settings,
    });
    await api.saveDiscordDestination({ id: "d1", name: "Spots", enabled: false, url: null, settings });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_discord_destination", {
      p_id: "d1", p_name: "Spots", p_enabled: false, p_url: null, p_settings: settings,
    });
    fake.rpcs.set("save_discord_destination", { error: { message: "Use a Discord webhook URL." } });
    await expect(api.saveDiscordDestination({ name: "Spots", enabled: true, url: "x", settings })).rejects.toThrow("Use a Discord webhook URL.");
    fake.rpcs.set("save_discord_destination", { error: { message: "" } });
    await expect(api.saveDiscordDestination({ name: "Spots", enabled: true, url: "x", settings })).rejects.toThrow("Couldn't save the destination.");
  });

  it("getDiscordDestination returns the RPC's json", async () => {
    const dest = { id: "d1", name: "Spots", enabled: true, url_display: "discord.com/api/webhooks/1/••••", settings };
    fake.rpcs.set("get_discord_destination", { data: dest });
    expect(await api.getDiscordDestination("d1")).toEqual(dest);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("get_discord_destination", { p_id: "d1" });
    fake.rpcs.set("get_discord_destination", { error: { message: "Destination not found." } });
    await expect(api.getDiscordDestination("d1")).rejects.toThrow("Destination not found.");
  });

  it("listDiscordDestinationSettings returns the rows, or none", async () => {
    const rows = [{ destination_id: "d1", style: "card", field_count: 9 }, { destination_id: "d2", style: "plain", field_count: 6 }];
    fake.rpcs.set("list_discord_destination_settings", { data: rows });
    expect(await api.listDiscordDestinationSettings()).toEqual(rows);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("list_discord_destination_settings");
    fake.rpcs.set("list_discord_destination_settings", { data: null });
    expect(await api.listDiscordDestinationSettings()).toEqual([]);
    fake.rpcs.set("list_discord_destination_settings", { error: boom });
    await expect(api.listDiscordDestinationSettings()).rejects.toThrow("boom");
  });

  it("previewDiscordMessage sends the settings and the spot, and returns SQL's keys", async () => {
    const preview = {
      discord_style: "card", discord_title: "KK4PWJ · 14.062 MHz · CW", discord_description: "POTA · US-2763", discord_grid: [{ name: "Band", value: "20m" }],
      discord_footer: "POTA · 17:42 UTC", discord_color: 5763719, discord_url: "https://longlines.io/call/KK4PWJ",
      discord_line: "**KK4PWJ** · 14.062 MHz", discord_suppress_embeds: false,
    };
    fake.rpcs.set("preview_discord_message", { data: preview });
    expect(await api.previewDiscordMessage(settings, 42)).toEqual(preview);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_discord_message", { p_settings: settings, p_spot_id: 42 });
    await api.previewDiscordMessage(settings, null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_discord_message", { p_settings: settings });
    fake.rpcs.set("preview_discord_message", { data: null });
    await expect(api.previewDiscordMessage(settings, null)).rejects.toThrow("Couldn't load the preview.");
    fake.rpcs.set("preview_discord_message", { error: { message: "Pick 1 to 8 fields for the message." } });
    await expect(api.previewDiscordMessage(settings, null)).rejects.toThrow("Pick 1 to 8 fields for the message.");
  });
});

describe("local cluster", () => {
  const settings: LocalClusterSettings = { relay_id: "r1", fields: ["reference", "comment"] };

  it("saveLocalClusterDestination creates without an id and updates with one", async () => {
    fake.rpcs.set("save_local_cluster_destination", { data: "l1" });
    expect(await api.saveLocalClusterDestination({ name: "Shack bandmap", enabled: true, settings })).toBe("l1");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_local_cluster_destination", {
      p_id: null, p_name: "Shack bandmap", p_enabled: true, p_settings: { relay_id: "r1", fields: ["reference", "comment"] },
    });
    await api.saveLocalClusterDestination({ id: "l1", name: "Shack bandmap", enabled: false, settings });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_local_cluster_destination", {
      p_id: "l1", p_name: "Shack bandmap", p_enabled: false, p_settings: { relay_id: "r1", fields: ["reference", "comment"] },
    });
    fake.rpcs.set("save_local_cluster_destination", { error: { message: "Pick a relay." } });
    await expect(api.saveLocalClusterDestination({ name: "x", enabled: true, settings })).rejects.toThrow("Pick a relay.");
    fake.rpcs.set("save_local_cluster_destination", { error: { message: "" } });
    await expect(api.saveLocalClusterDestination({ name: "x", enabled: true, settings })).rejects.toThrow("Couldn't save the destination.");
  });

  it("getLocalClusterDestination returns the RPC's json", async () => {
    const dest = { id: "l1", name: "Shack bandmap", enabled: true, url_display: "Long Lines Relay", settings };
    fake.rpcs.set("get_local_cluster_destination", { data: dest });
    expect(await api.getLocalClusterDestination("l1")).toEqual(dest);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("get_local_cluster_destination", { p_id: "l1" });
    fake.rpcs.set("get_local_cluster_destination", { error: { message: "Destination not found." } });
    await expect(api.getLocalClusterDestination("l1")).rejects.toThrow("Destination not found.");
  });

  it("listLocalClusterDestinationSettings returns the rows, or none", async () => {
    const rows = [{
      destination_id: "l1", relay_id: "r1", device_name: "Shack PC", platform: "windows", cluster_connected_at: null, fields: ["reference"],
    }];
    fake.rpcs.set("list_local_cluster_destination_settings", { data: rows });
    expect(await api.listLocalClusterDestinationSettings()).toEqual(rows);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("list_local_cluster_destination_settings");
    fake.rpcs.set("list_local_cluster_destination_settings", { data: null });
    expect(await api.listLocalClusterDestinationSettings()).toEqual([]);
    fake.rpcs.set("list_local_cluster_destination_settings", { error: boom });
    await expect(api.listLocalClusterDestinationSettings()).rejects.toThrow("boom");
  });

  it("previewLocalClusterLine sends only the fields and the spot, and returns SQL's line", async () => {
    const preview = {
      line: "DX de W4DOG:     14062.0  K4ABC        CW POTA K-0039                 2114Z", spotter: "W4DOG", frequency_khz: 14062,
      callsign: "K4ABC", comment: "CW POTA K-0039", time_utc: "2114",
    };
    fake.rpcs.set("preview_local_cluster_line", { data: preview });
    expect(await api.previewLocalClusterLine(["reference"], 42)).toEqual(preview);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_local_cluster_line", { p_settings: { fields: ["reference"] }, p_spot_id: 42 });
    await api.previewLocalClusterLine([], null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_local_cluster_line", { p_settings: { fields: [] } });
    fake.rpcs.set("preview_local_cluster_line", { data: null });
    await expect(api.previewLocalClusterLine([], null)).rejects.toThrow("Couldn't load the preview.");
    fake.rpcs.set("preview_local_cluster_line", { error: { message: "Unknown field x." } });
    await expect(api.previewLocalClusterLine([], null)).rejects.toThrow("Unknown field x.");
  });
});

describe("webhook", () => {
  const settings: WebhookSettings = {
    fields: ["id", "time", "callsign"], key_style: "snake", time_format: "iso_utc", frequency_unit: "khz", missing_values: "omit",
    batch_seconds: 0, retry_policy: "three_10m", pause_after_failures: 20,
  };

  it("saveWebhookDestination creates and returns the secret once", async () => {
    fake.rpcs.set("save_webhook_destination", { data: [{ id: "w1", signing_secret: "whsec_abc" }] });
    const url = "https://logger.example.org/hook/abc123";
    const headers = [{ name: "Authorization", value: "Bearer x" }];
    expect(await api.saveWebhookDestination({ name: "Logger", enabled: true, url, settings, headers }))
      .toEqual({ id: "w1", signingSecret: "whsec_abc" });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_webhook_destination", {
      p_id: null, p_name: "Logger", p_enabled: true, p_url: url, p_settings: settings, p_headers: headers,
    });
  });

  it("saveWebhookDestination updates with a null URL, sends saved headers without values and null headers as null", async () => {
    fake.rpcs.set("save_webhook_destination", { data: [{ id: "w1", signing_secret: null }] });
    expect(await api.saveWebhookDestination({
      id: "w1", name: "Logger", enabled: false, url: null, settings, headers: [{ name: "Authorization" }, { name: "X-Key", value: "k" }],
    })).toEqual({ id: "w1", signingSecret: null });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_webhook_destination", {
      p_id: "w1", p_name: "Logger", p_enabled: false, p_url: null, p_settings: settings,
      p_headers: [{ name: "Authorization" }, { name: "X-Key", value: "k" }],
    });
    await api.saveWebhookDestination({ id: "w1", name: "Logger", enabled: true, url: null, settings, headers: null });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_webhook_destination", expect.objectContaining({ p_headers: null }));
  });

  it("saveWebhookDestination surfaces SQL's message or falls back", async () => {
    const input = { name: "Logger", enabled: true, url: "http://x", settings, headers: [] };
    fake.rpcs.set("save_webhook_destination", { error: { message: "Use an https URL." } });
    await expect(api.saveWebhookDestination(input)).rejects.toThrow("Use an https URL.");
    fake.rpcs.set("save_webhook_destination", { error: { message: "" } });
    await expect(api.saveWebhookDestination(input)).rejects.toThrow("Couldn't save the destination.");
    fake.rpcs.set("save_webhook_destination", { data: [] });
    await expect(api.saveWebhookDestination(input)).rejects.toThrow("Couldn't save the destination.");
  });

  it("getWebhookDestination returns the RPC's json", async () => {
    const dest = {
      id: "w1", name: "Logger", enabled: true, url_display: "https://logger.example.org/hook/••••••", settings,
      headers: [{ name: "Authorization" }], secret_rotated_at: "2026-10-06T14:02:11Z", auto_disabled_at: null,
    };
    fake.rpcs.set("get_webhook_destination", { data: dest });
    expect(await api.getWebhookDestination("w1")).toEqual(dest);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("get_webhook_destination", { p_id: "w1" });
    fake.rpcs.set("get_webhook_destination", { error: { message: "Destination not found." } });
    await expect(api.getWebhookDestination("w1")).rejects.toThrow("Destination not found.");
  });

  it("listWebhookDestinationSettings returns the rows, or none", async () => {
    const rows = [{ destination_id: "w1", field_count: 11, batch_seconds: 0 }];
    fake.rpcs.set("list_webhook_destination_settings", { data: rows });
    expect(await api.listWebhookDestinationSettings()).toEqual(rows);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("list_webhook_destination_settings");
    fake.rpcs.set("list_webhook_destination_settings", { data: null });
    expect(await api.listWebhookDestinationSettings()).toEqual([]);
    fake.rpcs.set("list_webhook_destination_settings", { error: boom });
    await expect(api.listWebhookDestinationSettings()).rejects.toThrow("boom");
  });

  it("previewWebhookRequest sends the settings, spot and destination only when set, and keeps the body's key order", async () => {
    const body = { delivery_id: 0, connection: "Example connection", spot: { time: "2026-10-17T17:42:09Z", id: 1, callsign: "KK4PWJ" } };
    fake.rpcs.set("preview_webhook_request", { data: body });
    const got = await api.previewWebhookRequest(settings, 42, "w1");
    expect(got).toEqual(body);
    expect(Object.keys((got as typeof body).spot)).toEqual(["time", "id", "callsign"]);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_webhook_request", { p_settings: settings, p_spot_id: 42, p_destination_id: "w1" });
    await api.previewWebhookRequest(settings, null, null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("preview_webhook_request", { p_settings: settings });
    fake.rpcs.set("preview_webhook_request", { data: null });
    await expect(api.previewWebhookRequest(settings, null, null)).rejects.toThrow("Couldn't load the preview.");
    fake.rpcs.set("preview_webhook_request", { error: { message: "Pick at least one field." } });
    await expect(api.previewWebhookRequest(settings, null, null)).rejects.toThrow("Pick at least one field.");
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

describe("Long Lines Relay", () => {
  it("lookupRelayPairing returns lookup_relay_pairing's answer for the code as typed", async () => {
    fake.rpcs.set("lookup_relay_pairing", { data: { status: "expired", code: "KQ7M-X4PD" } });
    expect(await api.lookupRelayPairing("kq7mx4pd")).toEqual({ status: "expired", code: "KQ7M-X4PD" });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("lookup_relay_pairing", { p_user_code: "kq7mx4pd" });
    fake.rpcs.set("lookup_relay_pairing", {});
    await expect(api.lookupRelayPairing("x")).rejects.toThrow("Couldn't check the code.");
    fake.rpcs.set("lookup_relay_pairing", { error: boom });
    await expect(api.lookupRelayPairing("x")).rejects.toThrow("boom");
  });

  it("answerRelayPairing allows or denies a code", async () => {
    fake.rpcs.set("answer_relay_pairing", { data: { status: "approved" } });
    expect(await api.answerRelayPairing("KQ7M-X4PD", true)).toEqual({ status: "approved" });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("answer_relay_pairing", { p_user_code: "KQ7M-X4PD", p_approve: true });
    fake.rpcs.set("answer_relay_pairing", {});
    await expect(api.answerRelayPairing("x", false)).rejects.toThrow("Couldn't answer the relay.");
    fake.rpcs.set("answer_relay_pairing", { error: boom });
    await expect(api.answerRelayPairing("x", false)).rejects.toThrow("boom");
  });

  it("loadRelayTokens selects every column but the hash and the contact window", async () => {
    fake.tables.set("relay_tokens", { data: [{ id: "r1" }] });
    expect(await api.loadRelayTokens()).toEqual([{ id: "r1" }]);
    expect(fake.ops).toContainEqual(["relay_tokens", "select", [api.RELAY_TOKEN_COLUMNS]]);
    expect(api.RELAY_TOKEN_COLUMNS).not.toContain("token_hash");
    expect(api.RELAY_TOKEN_COLUMNS).not.toContain("contacts_window");
    // The Local DX cluster editor and the relay card read where it runs and whether its spots stream is open.
    expect(api.RELAY_TOKEN_COLUMNS).toContain("platform, cluster_connected_at");
    fake.tables.set("relay_tokens", { error: boom });
    await expect(api.loadRelayTokens()).rejects.toThrow("boom");
  });

  it("deleteRelayToken deletes by id", async () => {
    fake.tables.set("relay_tokens", {});
    await expect(api.deleteRelayToken("r1")).resolves.toBeUndefined();
    expect(fake.ops).toContainEqual(["relay_tokens", "eq", ["id", "r1"]]);
    fake.tables.set("relay_tokens", { error: boom });
    await expect(api.deleteRelayToken("r1")).rejects.toThrow("boom");
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
    name: "NC", enabled: true, sources: [], quiet_minutes: 0, destinations: ["d1"],
    rules: [[{ field: "group" as const, op: "is" as const, values: ["g1"] }]],
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
    fake.rpcs.set("preview_subscription", { data: [{ count: "7", spots: [{ id: 1 }], station_count: "12", window_size: "42", skipped_worked: "29" }] });
    expect(await api.previewSubscription(input)).toEqual({ count: 7, spots: [{ id: 1 }], station_count: 12, window_size: 42, skipped_worked: 29 });
    expect(fake.client.rpc).toHaveBeenCalledWith("preview_subscription", { filter: input });
    fake.rpcs.set("preview_subscription", { data: [{ count: "3", spots: [], station_count: "0", window_size: "5", skipped_worked: null }] });
    expect((await api.previewSubscription(input)).skipped_worked).toBeNull();
    fake.rpcs.set("preview_subscription", { data: [] });
    expect(await api.previewSubscription(input)).toEqual({ count: 0, spots: [], station_count: 0, window_size: 0, skipped_worked: null });
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

  it("saveGroup passes the sharing keys when given", async () => {
    fake.rpcs.set("save_callsign_group", { data: "g1" });
    await api.saveGroup({ id: "g1", name: "RARS", callsigns: [], public: true, show_callsigns: false });
    expect(fake.client.rpc).toHaveBeenCalledWith("save_callsign_group", {
      payload: { id: "g1", name: "RARS", callsigns: [], public: true, show_callsigns: false },
    });
  });

  it("listGroupSummaries keeps a group not built yet as null figures", async () => {
    fake.rpcs.set("list_group_summaries", {
      data: [
        { id: "g1", public: true, spots: "10082", members_heard: 19, member_count: 24, daily: [1, 2], on_air: ["W4ABC"] },
        { id: "g2", public: false, spots: null, members_heard: null, member_count: null, daily: null, on_air: [] },
      ],
    });
    expect(await api.listGroupSummaries()).toEqual([
      { id: "g1", public: true, spots: 10082, members_heard: 19, member_count: 24, daily: [1, 2], on_air: ["W4ABC"] },
      { id: "g2", public: false, spots: null, members_heard: null, member_count: null, daily: null, on_air: [] },
    ]);
    fake.rpcs.set("list_group_summaries", { error: boom });
    await expect(api.listGroupSummaries()).rejects.toThrow("boom");
  });

  it("loadGroupStatistics asks for one group and period", async () => {
    fake.rpcs.set("get_group_statistics", { data: { period: "7d", group: { id: "g1" } } });
    expect(await api.loadGroupStatistics("g1", "7d")).toEqual({ period: "7d", group: { id: "g1" } });
    expect(fake.client.rpc).toHaveBeenCalledWith("get_group_statistics", { p_id: "g1", p_period: "7d" });
    fake.rpcs.set("get_group_statistics", { data: null });
    await expect(api.loadGroupStatistics("g1", "7d")).rejects.toThrow("Couldn't load the statistics.");
    fake.rpcs.set("get_group_statistics", { error: { message: "Group not found." } });
    await expect(api.loadGroupStatistics("g1", "30d")).rejects.toThrow("Group not found.");
  });

  it("loadHomeFlow returns home_flow's payload", async () => {
    const flow = { matched: 3, delivered: 4, sources: [], subscriptions: [], links: [], subscription_sources: [] };
    fake.rpcs.set("home_flow", { data: flow });
    expect(await api.loadHomeFlow()).toEqual(flow);
    expect(fake.client.rpc).toHaveBeenCalledWith("home_flow");
    fake.rpcs.set("home_flow", { data: null });
    await expect(api.loadHomeFlow()).rejects.toThrow("Couldn't load your last 24 hours.");
    fake.rpcs.set("home_flow", { error: boom });
    await expect(api.loadHomeFlow()).rejects.toThrow("boom");
  });

  it("deleteGroup goes through its RPC", async () => {
    await api.deleteGroup("g1");
    expect(fake.client.rpc).toHaveBeenCalledWith("delete_callsign_group", { p_id: "g1" });
    fake.rpcs.set("delete_callsign_group", { error: { message: "Remove it from its connections first." } });
    await expect(api.deleteGroup("g1")).rejects.toThrow("Remove it from its connections first.");
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

describe("spotted activations", () => {
  it("GETs one activation by id with no session", async () => {
    fake.client.auth.getSession.mockClear();
    const fetchMock = respond(200, { id: "kjw2khkyj47f", callsign: "KK4PWJ" });
    expect(await api.loadSpottedActivation("kjw2khkyj47f")).toEqual({ id: "kjw2khkyj47f", callsign: "KK4PWJ" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/spotted-activations?id=kjw2khkyj47f");
    expect(init).toEqual({ headers: { apikey: "anon-key" } });
    expect(fake.client.auth.getSession).not.toHaveBeenCalled();
  });

  it("GETs a callsign's list with the call as given", async () => {
    const fetchMock = respond(200, { callsign: "KK4PWJ", recent: [], more: false });
    expect(await api.loadCallsignActivations("KK4PWJ/P")).toEqual({ callsign: "KK4PWJ", recent: [], more: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/spotted-activations?callsign=KK4PWJ%2FP");
    expect(init).toEqual({ headers: { apikey: "anon-key" } });
  });

  it("returns null for the function's own 404 on either route", async () => {
    respond(404, { error: "Spotted activation not found." });
    expect(await api.loadSpottedActivation("aaaaaaaaaaaa")).toBeNull();
    respond(404, { error: "Spotted activation not found." });
    expect(await api.loadCallsignActivations("W1HID")).toBeNull();
  });

  it("treats a gateway 404 as an outage, and rejects with any other failure", async () => {
    respond(404, { error: "Requested function was not found" });
    await expect(api.loadSpottedActivation("aaaaaaaaaaaa")).rejects.toMatchObject({ code: "404" });
    respond(404, { error: "Requested function was not found" });
    await expect(api.loadCallsignActivations("KK4PWJ")).rejects.toMatchObject({ code: "404" });
    respond(400, { error: "Enter a callsign, like KK4PWJ." });
    await expect(api.loadCallsignActivations("!!")).rejects.toMatchObject({ code: "400", message: "Enter a callsign, like KK4PWJ." });
    respond(429, { error: "Too many lookups. Try again in a minute." });
    await expect(api.loadSpottedActivation("aaaaaaaaaaaa")).rejects.toMatchObject({ code: "429" });
  });
});

describe("reference profiles", () => {
  it("GETs the reference-profile function with the program and reference as given and no session", async () => {
    fake.client.auth.getSession.mockClear();
    const fetchMock = respond(200, { program: "sota", reference: "W4C/CM-001" });
    expect(await api.loadReferenceProfile("sota", "W4C/CM-001")).toEqual({ program: "sota", reference: "W4C/CM-001" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/reference-profile?program=sota&reference=W4C%2FCM-001");
    expect(init).toEqual({ headers: { apikey: "anon-key" } });
    expect(fake.client.auth.getSession).not.toHaveBeenCalled();
  });

  it("returns null for the function's own 404", async () => {
    respond(404, { error: "Reference not found." });
    expect(await api.loadReferenceProfile("pota", "US-27X3")).toBeNull();
  });

  it("treats a gateway 404 as an outage, and rejects with any other failure", async () => {
    respond(404, { error: "Requested function was not found" });
    await expect(api.loadReferenceProfile("pota", "US-2763")).rejects.toMatchObject({ code: "404" });
    respond(429, { error: "Too many lookups. Try again in a minute." });
    await expect(api.loadReferenceProfile("pota", "US-2763")).rejects.toMatchObject({ code: "429" });
  });

  it("GETs reference-search with the query, and the program only when there is one", async () => {
    fake.client.auth.getSession.mockClear();
    const fetchMock = respond(200, { results: [], more: false });
    expect(await api.searchReferences("mount mitchell", null)).toEqual({ results: [], more: false });
    let [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/reference-search?q=mount+mitchell");
    expect(init).toEqual({ headers: { apikey: "anon-key" } });
    expect(fake.client.auth.getSession).not.toHaveBeenCalled();

    const sota = respond(200, { results: [], more: true });
    expect(await api.searchReferences("W4C/CM", "sota")).toEqual({ results: [], more: true });
    [url] = sota.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/reference-search?q=W4C%2FCM&program=sota");
  });

  it("rejects a refused search and the rate limit with the function's message and status", async () => {
    respond(400, { error: "A search is 2 to 64 characters." });
    await expect(api.searchReferences("x", null)).rejects.toMatchObject({ message: "A search is 2 to 64 characters.", code: "400" });
    respond(429, { error: "Too many lookups. Try again in a minute." });
    await expect(api.searchReferences("mitchell", "pota")).rejects.toMatchObject({ code: "429" });
  });
});

describe("band map", () => {
  it("GETs the band-map function with no session", async () => {
    fake.client.auth.getSession.mockClear();
    const payload = { bands: [], generated_at: "2026-10-14T13:45:00+00:00" };
    const fetchMock = respond(200, payload);
    expect(await api.loadBandMap()).toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/band-map");
    expect(init).toEqual({ headers: { apikey: "anon-key" } });
    expect(fake.client.auth.getSession).not.toHaveBeenCalled();
  });

  it("rejects with the function's message", async () => {
    respond(500, { error: "The band map is unavailable right now." });
    await expect(api.loadBandMap()).rejects.toMatchObject({ message: "The band map is unavailable right now.", code: "500" });
  });
});

describe("loadPublicGroup", () => {
  it("fetches a public page without a session", async () => {
    const payload = { period: "7d", group: { name: "Piedmont ARC", member_count: 24, show_callsigns: false } };
    const fetchMock = respond(200, payload);
    expect(await api.loadPublicGroup("7f3kq6xm2a", "7d")).toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/group-page?slug=7f3kq6xm2a&period=7d");
    expect(init).toEqual({ headers: { apikey: "anon-key" } });
    expect(fake.client.auth.getSession).not.toHaveBeenCalled();
  });

  it("returns null for a private or unknown page", async () => {
    respond(404, { error: "private" });
    expect(await api.loadPublicGroup("7f3kq6xm2a", "30d")).toBeNull();
  });

  it("treats a gateway 404 as an outage, not a private page", async () => {
    respond(404, { error: "Requested function was not found" });
    await expect(api.loadPublicGroup("7f3kq6xm2a", "30d")).rejects.toMatchObject({ code: "404" });
  });

  it("rejects with any other failure", async () => {
    respond(429, { error: "Too many lookups. Try again in a minute." });
    await expect(api.loadPublicGroup("7f3kq6xm2a", "30d")).rejects.toMatchObject({ code: "429" });
  });
});

describe("goals", () => {
  it("lists the cards and loads one list's progress", async () => {
    fake.rpcs.set("list_goals", { data: [{ id: "n1", name: "2026 chase" }] });
    expect(await api.listGoals()).toEqual([{ id: "n1", name: "2026 chase" }]);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("list_goals");
    fake.rpcs.set("get_goal", { data: { list: { id: "n1" } } });
    expect(await api.loadGoal("n1")).toEqual({ list: { id: "n1" } });
    expect(fake.client.rpc).toHaveBeenLastCalledWith("get_goal", { p_id: "n1" });
    fake.rpcs.set("get_goal", { data: null });
    await expect(api.loadGoal("n1")).rejects.toThrow("Couldn't load the goal.");
    fake.rpcs.set("get_goal", { error: { message: "Goal not found." } });
    await expect(api.loadGoal("n1")).rejects.toThrow("Goal not found.");
    fake.rpcs.set("list_goals", { error: { message: "" } });
    await expect(api.listGoals()).rejects.toThrow("Couldn't load your goals.");
  });

  it("saves, copies and deletes a list", async () => {
    const input = {
      name: "2026 chase", starts_on: "2026-01-01", ends_on: "2026-12-31", marking: "relay" as const,
      requirements: [{ kind: "band" as const, complete_when: "at_least" as const, at_least: 2, entries: ["20m", "40m", "80m"] }],
    };
    fake.rpcs.set("save_goal", { data: "n1" });
    expect(await api.saveGoal(input)).toBe("n1");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("save_goal", { payload: input });
    fake.rpcs.set("save_goal", { error: { message: "" } });
    await expect(api.saveGoal(input)).rejects.toThrow("Couldn't save the goal.");

    fake.rpcs.set("copy_goal", { data: "n2" });
    expect(await api.copyGoal("n1")).toBe("n2");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("copy_goal", { p_id: "n1" });
    fake.rpcs.set("copy_goal", { error: boom });
    await expect(api.copyGoal("n1")).rejects.toThrow("boom");

    await api.deleteGoal("n1");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("delete_goal", { p_id: "n1" });
    fake.rpcs.set("delete_goal", { error: { message: "Remove it from its connections first.", code: "LL409" } });
    await expect(api.deleteGoal("n1")).rejects.toMatchObject({ message: "Remove it from its connections first.", code: "LL409" });
  });

  it("marks entries and resolves reviews", async () => {
    await api.markGoalEntry("r1", "NC", true);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("mark_goal_entry", { p_requirement_id: "r1", p_value: "NC", p_worked: true });
    fake.rpcs.set("mark_goal_entry", { error: { message: "" } });
    await expect(api.markGoalEntry("r1", "NC", false)).rejects.toThrow("Couldn't update the entry.");

    await api.resolveGoalReview("v1", "US-2763");
    expect(fake.client.rpc).toHaveBeenLastCalledWith("resolve_goal_review", { p_id: "v1", p_reference: "US-2763" });
    await api.resolveGoalReview("v1", null);
    expect(fake.client.rpc).toHaveBeenLastCalledWith("resolve_goal_review", { p_id: "v1", p_reference: null });
    fake.rpcs.set("resolve_goal_review", { error: { message: "" } });
    await expect(api.resolveGoalReview("v1", null)).rejects.toThrow("Couldn't save that.");
  });
});
