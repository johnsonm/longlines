// The only module that calls navigator.serviceWorker.register.

export interface ServiceWorkerHost {
  serviceWorker?: {
    register(url: string, options: { type: "classic" | "module"; scope: string }): Promise<unknown>;
  };
}

/**
 * Registers the push service worker for the whole site. The build emits it as
 * /sw.js; the dev server serves the TypeScript source as a module worker (with
 * Service-Worker-Allowed: / so it can take the root scope). Registration
 * failing only costs push, so it is logged and never thrown.
 */
export async function registerServiceWorker(
  nav: ServiceWorkerHost = navigator,
  dev: boolean = import.meta.env.DEV,
): Promise<void> {
  if (!nav.serviceWorker) return;
  const url = dev ? "/src/pwa/sw.ts" : "/sw.js";
  try {
    await nav.serviceWorker.register(url, { type: dev ? "module" : "classic", scope: "/" });
  } catch (err) {
    console.warn("Service worker registration failed", err);
  }
}
