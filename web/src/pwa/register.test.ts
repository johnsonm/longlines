import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker, type ServiceWorkerHost } from "./register";

vi.mock("./push", () => ({ refreshPushRegistration: vi.fn() }));

function host(register: () => Promise<unknown> = async () => ({})) {
  const fn = vi.fn(register);
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const addEventListener = vi.fn((_type: "message", listener: (event: { data: unknown }) => void) => {
    listeners.push(listener);
  });
  const nav = { serviceWorker: { register: fn, addEventListener } } satisfies ServiceWorkerHost;
  return { nav, register: fn, post: (data: unknown) => listeners.forEach((l) => l({ data })) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerServiceWorker", () => {
  it("registers the built /sw.js as a classic worker in production", async () => {
    const { nav, register } = host();
    await registerServiceWorker(nav, false);
    expect(register).toHaveBeenCalledWith("/sw.js", { type: "classic", scope: "/" });
  });

  it("registers the TypeScript source as a module worker in dev", async () => {
    const { nav, register } = host();
    await registerServiceWorker(nav, true);
    expect(register).toHaveBeenCalledWith("/src/pwa/sw.ts", { type: "module", scope: "/" });
  });

  it("re-registers the push device when the worker reports a changed subscription", async () => {
    const { nav, post } = host();
    const refresh = vi.fn(() => Promise.resolve());
    await registerServiceWorker(nav, false, refresh);
    post({ type: "spot" });
    post("push-subscription-changed");
    post(null);
    expect(refresh).not.toHaveBeenCalled();
    post({ type: "push-subscription-changed" });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("registers where the container cannot be listened to", async () => {
    const register = vi.fn(async () => ({}));
    await registerServiceWorker({ serviceWorker: { register } }, false, async () => undefined);
    expect(register).toHaveBeenCalled();
  });

  it("does nothing where service workers are unsupported", async () => {
    await expect(registerServiceWorker({}, false)).resolves.toBeUndefined();
  });

  it("logs a failed registration instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = new Error("SecurityError");
    const { nav } = host(async () => {
      throw err;
    });
    await expect(registerServiceWorker(nav, false)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("Service worker registration failed", err);
  });
});
