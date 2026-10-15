import { describe, expect, it, vi } from "vitest";
import {
  type ClientsLike,
  handleNotificationClick,
  handlePush,
  handleSubscriptionChange,
  parsePushData,
  type RegistrationLike,
  type ShownNotificationOptions,
  SUBSCRIPTION_CHANGED,
  type WindowLike,
} from "./sw-handlers";

const ORIGIN = "https://longlines.io";

function notifications() {
  const shown: [string, ShownNotificationOptions][] = [];
  return {
    shown,
    showNotification: vi.fn(async (title: string, options: ShownNotificationOptions) => {
      shown.push([title, options]);
    }),
  };
}

function windowClient(url: string): WindowLike & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    url,
    messages,
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    postMessage: vi.fn((m: unknown) => {
      messages.push(m);
    }),
  };
}

function clients(windows: WindowLike[]) {
  return {
    matchAll: vi.fn<ClientsLike["matchAll"]>(async () => windows),
    openWindow: vi.fn(async () => undefined),
  };
}

const PUSH = { title: "K4SWL is on the air", body: "14062.0 kHz CW (20m)", tag: "spot:K4SWL", url: "/call/K4SWL" };

describe("handlePush", () => {
  it("shows a well-formed push with the app's icon, badge and click data", async () => {
    const target = notifications();
    await handlePush(PUSH, target);
    expect(target.shown).toEqual([[
      "K4SWL is on the air",
      {
        body: "14062.0 kHz CW (20m)",
        tag: "spot:K4SWL",
        data: { url: "/call/K4SWL", sourceUrl: undefined },
        icon: "/icon-192.png",
        badge: "/badge-72.png",
        actions: [],
        silent: false,
        renotify: true,
      },
    ]]);
  });

  it("passes the worker's actions, source URL and alert settings through", async () => {
    const target = notifications();
    await handlePush({
      ...PUSH,
      sourceUrl: "https://pota.app/#/park/US-2763",
      actions: [{ action: "profile", title: "Open profile" }, { action: "source", title: "Open on POTA" }],
      renotify: false,
    }, target);
    const [, options] = target.shown[0]!;
    expect(options.data).toEqual({ url: "/call/K4SWL", sourceUrl: "https://pota.app/#/park/US-2763" });
    expect(options.actions).toEqual([
      { action: "profile", title: "Open profile" },
      { action: "source", title: "Open on POTA" },
    ]);
    expect(options.renotify).toBe(false);
  });

  it("never asks for renotify on a silent notification", async () => {
    const target = notifications();
    await handlePush({ ...PUSH, silent: true, renotify: true }, target);
    expect(target.shown[0]![1]).toMatchObject({ silent: true, renotify: false });
  });

  it.each([
    ["no data", undefined],
    ["a string", "hello"],
    ["null", null],
    ["a missing title", { ...PUSH, title: undefined }],
    ["a numeric url", { ...PUSH, url: 7 }],
  ])("ignores %s", async (_label, data) => {
    const target = notifications();
    await handlePush(data, target);
    expect(target.showNotification).not.toHaveBeenCalled();
  });
});

describe("parsePushData", () => {
  it("drops unknown actions and mistyped optional fields", () => {
    expect(parsePushData({
      ...PUSH,
      sourceUrl: 3,
      actions: [{ action: "delete", title: "Delete" }, { action: "source" }, "profile", {
        action: "profile",
        title: "Open profile",
      }],
      silent: "yes",
      renotify: 1,
    })).toEqual({
      ...PUSH,
      sourceUrl: undefined,
      actions: [{ action: "profile", title: "Open profile" }],
      silent: undefined,
      renotify: undefined,
    });
  });
});

describe("handleNotificationClick", () => {
  const data = { url: "/call/K4SWL", sourceUrl: "https://pota.app/#/park/US-2763" };

  it("focuses an open window and navigates it to the profile", async () => {
    const other = windowClient("https://example.com/");
    const app = windowClient(`${ORIGIN}/stats`);
    const c = clients([other, app]);
    await handleNotificationClick("", data, c, ORIGIN);
    expect(c.matchAll).toHaveBeenCalledWith({ type: "window" });
    expect(app.focus).toHaveBeenCalled();
    expect(app.navigate).toHaveBeenCalledWith(`${ORIGIN}/call/K4SWL`);
    expect(other.navigate).not.toHaveBeenCalled();
    expect(c.openWindow).not.toHaveBeenCalled();
  });

  it("opens a window when none is open", async () => {
    const c = clients([]);
    await handleNotificationClick("profile", data, c, ORIGIN);
    expect(c.openWindow).toHaveBeenCalledWith(`${ORIGIN}/call/K4SWL`);
  });

  it("opens the source site in a window of its own for the source action", async () => {
    const app = windowClient(`${ORIGIN}/`);
    const c = clients([app]);
    await handleNotificationClick("source", data, c, ORIGIN);
    expect(c.openWindow).toHaveBeenCalledWith("https://pota.app/#/park/US-2763");
    expect(app.navigate).not.toHaveBeenCalled();
    expect(c.matchAll).not.toHaveBeenCalled();
  });

  it("falls back to the profile when the source action has no source URL", async () => {
    const c = clients([]);
    await handleNotificationClick("source", { url: "/call/K4SWL" }, c, ORIGIN);
    expect(c.openWindow).toHaveBeenCalledWith(`${ORIGIN}/call/K4SWL`);
  });

  it.each([
    ["no data", undefined],
    ["data without a url", { sourceUrl: "https://pota.app/" }],
    ["a javascript: url", { url: "javascript:alert(1)" }],
    ["an unparseable url", { url: "http://[" }],
  ])("does nothing for %s", async (_label, d) => {
    const c = clients([windowClient(`${ORIGIN}/`)]);
    await handleNotificationClick("", d, c, ORIGIN);
    expect(c.openWindow).not.toHaveBeenCalled();
    expect(c.matchAll).not.toHaveBeenCalled();
  });
});

describe("handleSubscriptionChange", () => {
  const key = new Uint8Array([4, 1, 2, 3]).buffer;

  function registration(subscribe: RegistrationLike["pushManager"]["subscribe"]) {
    return { pushManager: { subscribe: vi.fn(subscribe) } };
  }

  it("re-subscribes with the old key and tells every window", async () => {
    const reg = registration(async () => ({}));
    const a = windowClient(`${ORIGIN}/`);
    const b = windowClient(`${ORIGIN}/destinations`);
    const c = clients([a, b]);
    await handleSubscriptionChange(reg, { options: { applicationServerKey: key } }, c);
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
    expect(c.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(a.messages).toEqual([{ type: SUBSCRIPTION_CHANGED }]);
    expect(b.messages).toEqual([{ type: SUBSCRIPTION_CHANGED }]);
  });

  it("still tells the windows when re-subscribing fails", async () => {
    const reg = registration(async () => {
      throw new Error("AbortError");
    });
    const a = windowClient(`${ORIGIN}/`);
    await handleSubscriptionChange(reg, { options: { applicationServerKey: key } }, clients([a]));
    expect(a.messages).toEqual([{ type: SUBSCRIPTION_CHANGED }]);
  });

  it("leaves re-subscribing to the window when there is no old key", async () => {
    const reg = registration(async () => ({}));
    const a = windowClient(`${ORIGIN}/`);
    await handleSubscriptionChange(reg, null, clients([a]));
    await handleSubscriptionChange(reg, { options: { applicationServerKey: null } }, clients([a]));
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(a.messages).toHaveLength(2);
  });
});
