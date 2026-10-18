import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPushDevices, registerPushDevice, reportPushDeviceBlocked, unregisterPushDevice, type PushDevice } from "../lib/api";
import {
  base64UrlToBytes, browserEnv, currentEndpoint, DENIED_TEXT, deviceAgent, disablePush, enablePush, ENDPOINT_KEY, isIos, isStandalone,
  pushCleanup, pushSupport, refreshPushRegistration, UNSUPPORTED_TEXT, type PushEnv, type PushSubscriptionLike,
} from "./push";

vi.mock("../lib/api", () => ({
  listPushDevices: vi.fn(),
  registerPushDevice: vi.fn(),
  reportPushDeviceBlocked: vi.fn(),
  unregisterPushDevice: vi.fn(),
}));

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const KEY = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function subscription(endpoint = "https://fcm.googleapis.com/fcm/send/abc"): PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    endpoint,
    toJSON: () => ({ keys: { p256dh: "p256", auth: "auth16" } }),
    unsubscribe: vi.fn(() => Promise.resolve(true)),
  };
}

/** A supported desktop Chrome, permission `granted` by default; `order` records the calls that matter. */
function fakeEnv(overrides: Partial<PushEnv> = {}, sub: PushSubscriptionLike | null = null) {
  const order: string[] = [];
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(sub)),
    subscribe: vi.fn(() => {
      order.push("subscribe");
      return Promise.resolve(subscription());
    }),
  };
  const env: PushEnv = {
    publicKey: KEY,
    notification: {
      permission: "granted",
      requestPermission: vi.fn(() => {
        order.push("requestPermission");
        return Promise.resolve("granted" as NotificationPermission);
      }),
    },
    serviceWorker: {
      get ready() {
        order.push("ready");
        return Promise.resolve({ pushManager });
      },
    },
    pushManager: true,
    userAgent: EDGE_WINDOWS,
    userAgentData: null,
    maxTouchPoints: 0,
    standalone: false,
    storage: memoryStorage(),
    ...overrides,
  };
  return { env, order, pushManager };
}

/** list_push_devices as the account sees it; only is_current matters here. */
function listed(current: boolean): PushDevice[] {
  return [{
    id: "dev1", label: "Edge on Windows", agent: "Edge on Windows", standalone: false, created_at: "2026-10-01T00:00:00Z", last_success_at: null,
    last_error: null, last_error_at: null, blocked_at: null, is_current: current, destination_ids: [],
  }];
}

beforeEach(() => {
  for (const fn of [listPushDevices, registerPushDevice, reportPushDeviceBlocked, unregisterPushDevice]) vi.mocked(fn).mockReset();
  vi.mocked(listPushDevices).mockResolvedValue(listed(true));
  vi.mocked(registerPushDevice).mockResolvedValue("dev1");
  vi.mocked(unregisterPushDevice).mockResolvedValue(undefined);
  vi.mocked(reportPushDeviceBlocked).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deviceAgent", () => {
  it.each([
    ["Chrome on Android", { userAgent: CHROME_ANDROID }],
    ["Safari on iPhone", { userAgent: SAFARI_IPHONE }],
    ["Safari on iPad", { userAgent: SAFARI_IPAD, maxTouchPoints: 5 }],
    ["Safari on macOS", { userAgent: SAFARI_IPAD }],
    ["Firefox on Linux", { userAgent: FIREFOX_LINUX }],
    ["Edge on Windows", { userAgent: EDGE_WINDOWS }],
    ["Chrome on Windows", { userAgent: EDGE_WINDOWS, userAgentData: { brands: [{ brand: "Google Chrome" }, { brand: "Not;A=Brand" }], platform: "Windows" } }],
    ["Edge on macOS", { userAgent: "", userAgentData: { brands: [{ brand: "Microsoft Edge" }], platform: "macOS" } }],
    ["Chrome on ChromeOS", { userAgent: "", userAgentData: { brands: [{ brand: "Chromium" }], platform: "Chrome OS" } }],
    ["Samsung Internet on Android", { userAgent: "Mozilla/5.0 (Linux; Android 14) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36" }],
    ["Opera on Linux", { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0" }],
    ["Chrome", { userAgent: "Mozilla/5.0 (Unknown) Chrome/1.0 Safari/537.36" }],
    ["This browser", { userAgent: "curl/8.0" }],
    ["This browser", { userAgent: "" }],
  ])("is %s", (expected, overrides) => {
    expect(deviceAgent(fakeEnv(overrides as Partial<PushEnv>).env)).toBe(expected);
  });

  it("isIos covers iPhone, iPad and iPadOS presenting as a Mac", () => {
    expect(isIos(fakeEnv({ userAgent: SAFARI_IPHONE }).env)).toBe(true);
    expect(isIos(fakeEnv({ userAgent: SAFARI_IPAD, maxTouchPoints: 5 }).env)).toBe(true);
    expect(isIos(fakeEnv({ userAgent: SAFARI_IPAD }).env)).toBe(false);
    expect(isIos(fakeEnv({ userAgent: CHROME_ANDROID }).env)).toBe(false);
  });

  it("isStandalone reads the env", () => {
    expect(isStandalone(fakeEnv().env)).toBe(false);
    expect(isStandalone(fakeEnv({ standalone: true }).env)).toBe(true);
  });
});

describe("pushSupport", () => {
  it("is unsupported without a VAPID key, whatever the browser", async () => {
    expect(await pushSupport(fakeEnv({ publicKey: "" }).env)).toBe("unsupported");
  });

  it("is unsupported without the push APIs", async () => {
    expect(await pushSupport(fakeEnv({ notification: null }).env)).toBe("unsupported");
    expect(await pushSupport(fakeEnv({ serviceWorker: null }).env)).toBe("unsupported");
    expect(await pushSupport(fakeEnv({ pushManager: false }).env)).toBe("unsupported");
  });

  it("asks iPhone and iPad Safari to install first, even without the APIs", async () => {
    expect(await pushSupport(fakeEnv({ userAgent: SAFARI_IPHONE, pushManager: false }).env)).toBe("ios-needs-install");
    expect(await pushSupport(fakeEnv({ userAgent: SAFARI_IPAD, maxTouchPoints: 5 }).env)).toBe("ios-needs-install");
  });

  it("is on for an installed iPhone app that is subscribed", async () => {
    expect(await pushSupport(fakeEnv({ userAgent: SAFARI_IPHONE, standalone: true }, subscription()).env)).toBe("on");
  });

  it("counts the browser as unsubscribed when no service worker becomes active in time", async () => {
    const { env } = fakeEnv({ serviceWorker: { ready: new Promise(() => {}) }, readyTimeoutMs: 5 }, subscription());
    await expect(pushSupport(env)).resolves.toBe("off");
  });

  it("is denied, off or on from the permission and the subscription", async () => {
    const denied = fakeEnv({ notification: { permission: "denied", requestPermission: vi.fn() } });
    expect(await pushSupport(denied.env)).toBe("denied");
    const asked = fakeEnv({ notification: { permission: "default", requestPermission: vi.fn() } }, subscription());
    expect(await pushSupport(asked.env)).toBe("off");
    expect(await pushSupport(fakeEnv().env)).toBe("off");
    expect(await pushSupport(fakeEnv({}, subscription()).env)).toBe("on");
  });
});

describe("enablePush", () => {
  it("asks for permission before anything else, subscribes and registers the device", async () => {
    const { env, order, pushManager } = fakeEnv();
    const pending = enablePush("My laptop", env);
    // Synchronously: the user gesture must still be live.
    expect(order).toEqual(["requestPermission"]);
    expect(await pending).toBe("dev1");
    expect(order).toEqual(["requestPermission", "ready", "subscribe"]);
    const [options] = pushManager.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }];
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toEqual(base64UrlToBytes(KEY));
    expect(registerPushDevice).toHaveBeenCalledWith(
      { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "p256", auth: "auth16" },
      "My laptop", "Edge on Windows", false,
    );
    expect(currentEndpoint(env)).toBe("https://fcm.googleapis.com/fcm/send/abc");
  });

  it("reuses an existing subscription and reports an installed app", async () => {
    const { env, pushManager } = fakeEnv({ standalone: true, userAgent: CHROME_ANDROID }, subscription("https://fcm.googleapis.com/fcm/send/old"));
    await enablePush("Phone", env);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(registerPushDevice).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://fcm.googleapis.com/fcm/send/old" }), "Phone", "Chrome on Android", true);
  });

  it("fails as unsupported without Notification, the APIs or a key", async () => {
    await expect(enablePush("x", fakeEnv({ notification: null }).env)).rejects.toThrow(UNSUPPORTED_TEXT);
    await expect(enablePush("x", fakeEnv({ pushManager: false }).env)).rejects.toThrow(UNSUPPORTED_TEXT);
    await expect(enablePush("x", fakeEnv({ publicKey: "" }).env)).rejects.toThrow(UNSUPPORTED_TEXT);
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it("fails as denied when the user does not allow", async () => {
    const { env } = fakeEnv({ notification: { permission: "default", requestPermission: () => Promise.resolve("denied") } });
    await expect(enablePush("x", env)).rejects.toThrow(DENIED_TEXT);
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it("fails rather than hang when no service worker becomes active", async () => {
    const { env } = fakeEnv({ serviceWorker: { ready: new Promise(() => {}) }, readyTimeoutMs: 5 });
    await expect(enablePush("Shack", env)).rejects.toThrow("Couldn't turn on notifications.");
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it("fails when the browser's subscription has no keys", async () => {
    const bad: PushSubscriptionLike = { endpoint: "https://fcm.googleapis.com/x", toJSON: () => ({}), unsubscribe: () => Promise.resolve(true) };
    await expect(enablePush("x", fakeEnv({}, bad).env)).rejects.toThrow("Couldn't turn on notifications.");
  });

  it("unsubscribes a subscription it made when the registration fails", async () => {
    vi.mocked(registerPushDevice).mockRejectedValue(new Error("You can turn on notifications on up to 20 devices. Remove one first."));
    const { env, pushManager } = fakeEnv();
    await expect(enablePush("x", env)).rejects.toThrow("up to 20 devices");
    const made = (await pushManager.subscribe.mock.results[0]!.value) as ReturnType<typeof subscription>;
    expect(made.unsubscribe).toHaveBeenCalled();
    expect(currentEndpoint(env)).toBeNull();
    // An unsubscribe that fails too still reports the registration's error.
    const failing = fakeEnv();
    failing.pushManager.subscribe.mockImplementation(() => {
      const sub = subscription();
      sub.unsubscribe.mockRejectedValue(new Error("gone"));
      return Promise.resolve(sub);
    });
    await expect(enablePush("x", failing.env)).rejects.toThrow("up to 20 devices");
  });

  it("keeps a subscription it reused when the registration fails", async () => {
    vi.mocked(registerPushDevice).mockRejectedValue(new Error("offline"));
    const sub = subscription();
    await expect(enablePush("x", fakeEnv({}, sub).env)).rejects.toThrow("offline");
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it("still registers when localStorage throws", async () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined };
    const { env } = fakeEnv({ storage });
    expect(await enablePush("x", env)).toBe("dev1");
    expect(currentEndpoint(env)).toBeNull();
  });
});

describe("disablePush and pushCleanup", () => {
  it("unregisters the subscription's endpoint, unsubscribes and forgets it", async () => {
    const sub = subscription();
    const { env } = fakeEnv({ storage: memoryStorage({ [ENDPOINT_KEY]: sub.endpoint }) }, sub);
    await disablePush(env);
    expect(unregisterPushDevice).toHaveBeenCalledWith(sub.endpoint);
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(currentEndpoint(env)).toBeNull();
  });

  it("falls back to the remembered endpoint when the browser has no subscription", async () => {
    const { env } = fakeEnv({ storage: memoryStorage({ [ENDPOINT_KEY]: "https://fcm.googleapis.com/fcm/send/kept" }) });
    await disablePush(env);
    expect(unregisterPushDevice).toHaveBeenCalledWith("https://fcm.googleapis.com/fcm/send/kept");
    expect(currentEndpoint(env)).toBeNull();
  });

  it("does nothing where unsupported and nothing is remembered", async () => {
    await disablePush(fakeEnv({ notification: null }).env);
    expect(unregisterPushDevice).not.toHaveBeenCalled();
  });

  it("unsubscribes and forgets the endpoint even when the RPC fails, then reports the failure", async () => {
    vi.mocked(unregisterPushDevice).mockRejectedValue(new Error("offline"));
    const sub = subscription();
    const { env } = fakeEnv({ storage: memoryStorage({ [ENDPOINT_KEY]: sub.endpoint }) }, sub);
    await expect(disablePush(env)).rejects.toThrow("offline");
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(currentEndpoint(env)).toBeNull();
    vi.mocked(unregisterPushDevice).mockRejectedValue("gone");
    await expect(disablePush(fakeEnv({}, subscription()).env)).rejects.toThrow("gone");
  });

  it("falls back to the remembered endpoint when no service worker becomes active", async () => {
    const { env } = fakeEnv({
      serviceWorker: { ready: new Promise(() => {}) }, readyTimeoutMs: 5, storage: memoryStorage({ [ENDPOINT_KEY]: "https://fcm.googleapis.com/fcm/send/kept" }),
    });
    await disablePush(env);
    expect(unregisterPushDevice).toHaveBeenCalledWith("https://fcm.googleapis.com/fcm/send/kept");
  });

  it("pushCleanup swallows failures", async () => {
    vi.mocked(unregisterPushDevice).mockRejectedValue(new Error("offline"));
    const { env } = fakeEnv({}, subscription());
    await expect(pushCleanup(env)).resolves.toBeUndefined();
    await expect(pushCleanup(fakeEnv({ notification: null }).env)).resolves.toBeUndefined();
  });

  it("currentEndpoint is null when storage throws or is missing", () => {
    expect(currentEndpoint(fakeEnv({ storage: null }).env)).toBeNull();
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined, removeItem: () => undefined };
    expect(currentEndpoint(fakeEnv({ storage }).env)).toBeNull();
  });
});

describe("refreshPushRegistration", () => {
  it("re-registers the keys only when granted and subscribed", async () => {
    const sub = subscription();
    const { env } = fakeEnv({}, sub);
    await refreshPushRegistration(env);
    expect(listPushDevices).toHaveBeenCalledWith(sub.endpoint);
    expect(registerPushDevice).toHaveBeenCalledWith({ endpoint: sub.endpoint, p256dh: "p256", auth: "auth16" }, null, null, null, null);
    expect(currentEndpoint(env)).toBe(sub.endpoint);
  });

  it("re-registers an unchanged endpoint without a previous one", async () => {
    vi.mocked(listPushDevices).mockResolvedValue(listed(true));
    const sub = subscription();
    const { env } = fakeEnv({ storage: memoryStorage({ [ENDPOINT_KEY]: sub.endpoint }) }, sub);
    await refreshPushRegistration(env);
    expect(registerPushDevice).toHaveBeenCalledWith(expect.objectContaining({ endpoint: sub.endpoint }), null, null, null, null);
  });

  it("registers a subscription the account does not list yet, such as a rotated endpoint", async () => {
    vi.mocked(listPushDevices).mockResolvedValue(listed(false));
    const sub = subscription("https://fcm.googleapis.com/fcm/send/rotated");
    const { env } = fakeEnv({ storage: memoryStorage({ [ENDPOINT_KEY]: "https://fcm.googleapis.com/fcm/send/old" }) }, sub);
    await refreshPushRegistration(env);
    // The remembered endpoint goes along, so the device it names moves to the new one with its destinations.
    expect(registerPushDevice).toHaveBeenCalledWith(
      { endpoint: sub.endpoint, p256dh: "p256", auth: "auth16" }, null, null, null, "https://fcm.googleapis.com/fcm/send/old",
    );
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(currentEndpoint(env)).toBe(sub.endpoint);
    // Never remembered (storage blocked): registered with no previous endpoint.
    vi.mocked(registerPushDevice).mockClear();
    await refreshPushRegistration(fakeEnv({ storage: null }, subscription()).env);
    expect(registerPushDevice).toHaveBeenCalledWith(expect.anything(), null, null, null, null);
  });

  it("follows a removal made from another device: unsubscribes instead of registering again", async () => {
    vi.mocked(listPushDevices).mockResolvedValue([]);
    const sub = subscription();
    const { env } = fakeEnv({ storage: memoryStorage({ [ENDPOINT_KEY]: sub.endpoint }) }, sub);
    await refreshPushRegistration(env);
    expect(registerPushDevice).not.toHaveBeenCalled();
    expect(unregisterPushDevice).not.toHaveBeenCalled();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(currentEndpoint(env)).toBeNull();
  });

  it("reports the remembered endpoint blocked when denied", async () => {
    const { env } = fakeEnv({
      notification: { permission: "denied", requestPermission: vi.fn() },
      storage: memoryStorage({ [ENDPOINT_KEY]: "https://fcm.googleapis.com/fcm/send/abc" }),
    });
    await refreshPushRegistration(env);
    expect(reportPushDeviceBlocked).toHaveBeenCalledWith("https://fcm.googleapis.com/fcm/send/abc");
    expect(registerPushDevice).not.toHaveBeenCalled();
  });

  it("does nothing when denied without a remembered endpoint, not yet asked, unsubscribed or unsupported", async () => {
    await refreshPushRegistration(fakeEnv({ notification: { permission: "denied", requestPermission: vi.fn() } }).env);
    await refreshPushRegistration(fakeEnv({ notification: { permission: "default", requestPermission: vi.fn() } }).env);
    await refreshPushRegistration(fakeEnv().env);
    await refreshPushRegistration(fakeEnv({ publicKey: "" }, subscription()).env);
    await refreshPushRegistration(fakeEnv({ pushManager: false }, subscription()).env);
    expect(registerPushDevice).not.toHaveBeenCalled();
    expect(reportPushDeviceBlocked).not.toHaveBeenCalled();
  });

  it("logs and resolves when the registration fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(registerPushDevice).mockRejectedValue(new Error("Sign in again."));
    await expect(refreshPushRegistration(fakeEnv({}, subscription()).env)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Push registration refresh failed", expect.any(Error));
  });
});

describe("base64UrlToBytes", () => {
  it("decodes the URL-safe alphabet without padding", () => {
    expect(Array.from(base64UrlToBytes("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(base64UrlToBytes("_-8"))).toEqual([255, 239]);
    expect(base64UrlToBytes(KEY)).toHaveLength(65);
    expect(base64UrlToBytes(KEY)[0]).toBe(4);
  });
});

describe("browserEnv", () => {
  it("reads nothing in node", () => {
    const env = browserEnv();
    expect(env.notification).toBeNull();
    expect(env.serviceWorker).toBeNull();
    expect(env.pushManager).toBe(false);
    expect(env.standalone).toBe(false);
    expect(env.storage).toBeNull();
    expect(env.maxTouchPoints).toBe(0);
  });

  it("reads the browser globals, including Safari's navigator.standalone", () => {
    const notification = { permission: "granted", requestPermission: () => Promise.resolve("granted") };
    const localStorage = memoryStorage();
    vi.stubGlobal("window", {
      Notification: notification,
      PushManager: class {},
      localStorage,
      matchMedia: (q: string) => ({ matches: q === "(display-mode: standalone)" }),
    });
    const serviceWorker = { ready: Promise.resolve({ pushManager: {} }) };
    vi.stubGlobal("navigator", {
      serviceWorker, userAgent: CHROME_ANDROID, userAgentData: { brands: [{ brand: "Google Chrome" }], platform: "Android" }, maxTouchPoints: 5,
    });
    const env = browserEnv();
    expect(env.notification).toBe(notification);
    expect(env.serviceWorker).toBe(serviceWorker);
    expect(env.pushManager).toBe(true);
    expect(env.userAgent).toBe(CHROME_ANDROID);
    expect(env.userAgentData?.platform).toBe("Android");
    expect(env.maxTouchPoints).toBe(5);
    expect(env.standalone).toBe(true);
    expect(env.storage).toBe(localStorage);

    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("navigator", { userAgent: SAFARI_IPHONE, standalone: true });
    const ios = browserEnv();
    expect(ios.notification).toBeNull();
    expect(ios.pushManager).toBe(false);
    expect(ios.standalone).toBe(true);
    expect(ios.storage).toBeNull();
    expect(ios.userAgentData).toBeNull();
  });
});
