// The only module that calls navigator.serviceWorker.register.

import { refreshPushRegistration } from "./push";

export interface ServiceWorkerHost {
  serviceWorker?: {
    register(url: string, options: { type: "classic" | "module"; scope: string }): Promise<unknown>;
    addEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
  };
}

// The message sw-handlers.ts posts after pushsubscriptionchange. The same
// literal, not an import: app code importing the worker's module would put
// sw.js in a shared chunk (vite.config.ts fails the build).
const SUBSCRIPTION_CHANGED = "push-subscription-changed";

function isSubscriptionChanged(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === SUBSCRIPTION_CHANGED;
}

/**
 * Registers the push service worker for the whole site. The build emits it as
 * /sw.js; the dev server serves the TypeScript source as a module worker (with
 * Service-Worker-Allowed: / so it can take the root scope). Registration
 * failing only costs push, so it is logged and never thrown.
 *
 * The worker cannot reach the session, so when the push service replaces the
 * subscription it re-subscribes and posts push-subscription-changed; the page
 * then re-registers the new keys (refreshPushRegistration never throws).
 */
export async function registerServiceWorker(
  nav: ServiceWorkerHost = navigator,
  dev: boolean = import.meta.env.DEV,
  onSubscriptionChanged: () => Promise<void> = refreshPushRegistration,
): Promise<void> {
  if (!nav.serviceWorker) return;
  nav.serviceWorker.addEventListener?.("message", (event) => {
    if (isSubscriptionChanged(event.data)) void onSubscriptionChanged();
  });
  const url = dev ? "/src/pwa/sw.ts" : "/sw.js";
  try {
    await nav.serviceWorker.register(url, { type: dev ? "module" : "classic", scope: "/" });
  } catch (err) {
    console.warn("Service worker registration failed", err);
  }
}
