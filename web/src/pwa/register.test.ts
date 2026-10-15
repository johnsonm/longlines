import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker, type ServiceWorkerHost } from "./register";

function host(register: () => Promise<unknown> = async () => ({})) {
  const fn = vi.fn(register);
  return { nav: { serviceWorker: { register: fn } } satisfies ServiceWorkerHost, register: fn };
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
