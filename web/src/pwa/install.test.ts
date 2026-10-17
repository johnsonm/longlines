import { afterEach, describe, expect, it, vi } from "vitest";
import type { PushEnv } from "./push";
import { captureInstallPrompt, installState, promptInstall, resetInstallPrompt, subscribeInstall, type InstallPromptEvent } from "./install";

// push.ts (for isIos and isStandalone) imports the api module, which needs a configured client.
vi.mock("../lib/api", () => ({ registerPushDevice: vi.fn(), reportPushDeviceBlocked: vi.fn(), unregisterPushDevice: vi.fn() }));

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function env(userAgent: string, standalone = false): PushEnv {
  return {
    publicKey: "", notification: null, serviceWorker: null, pushManager: false, userAgent, userAgentData: null, maxTouchPoints: 0, standalone, storage: null,
  };
}

function promptEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const prompt = vi.fn(() => Promise.resolve());
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome }) });
  return { event: event as InstallPromptEvent, prompt };
}

afterEach(() => {
  resetInstallPrompt();
});

describe("installState", () => {
  it("is none without a prompt on a browser that is not Safari on iOS", () => {
    expect(installState(env(CHROME_ANDROID))).toBe("none");
  });

  it("is ios for Safari on an iPhone that has not been installed", () => {
    expect(installState(env(SAFARI_IPHONE))).toBe("ios");
  });

  it("is none once the app runs installed, whatever the browser", () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    target.dispatchEvent(promptEvent().event);
    expect(installState(env(SAFARI_IPHONE, true))).toBe("none");
    expect(installState(env(CHROME_ANDROID, true))).toBe("none");
  });
});

describe("captureInstallPrompt", () => {
  it("keeps the browser's prompt, cancels its own bar and notifies subscribers", () => {
    const target = new EventTarget();
    const listener = vi.fn();
    const unsubscribe = subscribeInstall(listener);
    captureInstallPrompt(target);
    const { event } = promptEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(installState(env(CHROME_ANDROID))).toBe("prompt");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    target.dispatchEvent(new Event("appinstalled"));
    expect(installState(env(CHROME_ANDROID))).toBe("none");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("prefers the prompt over the iOS steps when a browser offers one", () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    target.dispatchEvent(promptEvent().event);
    expect(installState(env(SAFARI_IPHONE))).toBe("prompt");
  });
});

describe("promptInstall", () => {
  it("shows the captured prompt once and reports the choice", async () => {
    const target = new EventTarget();
    const listener = vi.fn();
    subscribeInstall(listener);
    captureInstallPrompt(target);
    const { event, prompt } = promptEvent("accepted");
    target.dispatchEvent(event);
    listener.mockClear();
    await expect(promptInstall()).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(installState(env(CHROME_ANDROID))).toBe("none");
    expect(listener).toHaveBeenCalledTimes(1);
    // The event is spent.
    await expect(promptInstall()).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("reports a dismissed prompt", async () => {
    const target = new EventTarget();
    captureInstallPrompt(target);
    target.dispatchEvent(promptEvent("dismissed").event);
    await expect(promptInstall()).resolves.toBe(false);
  });

  it("does nothing without a prompt", async () => {
    await expect(promptInstall()).resolves.toBe(false);
  });
});
