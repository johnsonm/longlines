// Installing the web app. Chrome and its relatives offer an install prompt
// through beforeinstallprompt, which fires early and only once, so main.tsx
// captures it before the first render; Safari on iPhone and iPad has no
// prompt and gets the Home Screen steps instead. Nothing here touches push.

import { browserEnv, isIos, isStandalone, type PushEnv } from "./push";

export type InstallState = "prompt" | "ios" | "none";

/** The part of Chrome's BeforeInstallPromptEvent this module uses. */
export interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Call once, before the app renders. preventDefault keeps the browser's own
 * install bar away; the event is kept for promptInstall(). Once the app is
 * installed (appinstalled) the prompt is forgotten and the menu item goes.
 */
export function captureInstallPrompt(target: EventTarget = window): void {
  target.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  target.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

/**
 * `prompt` where the browser has offered to install, `ios` for Safari on an
 * iPhone or iPad, `none` elsewhere and whenever the app is already running
 * installed.
 */
export function installState(env: PushEnv = browserEnv()): InstallState {
  if (isStandalone(env)) return "none";
  if (deferred) return "prompt";
  if (isIos(env)) return "ios";
  return "none";
}

/**
 * Shows the browser's install prompt; true when the user accepted. The event
 * works once, so it is forgotten as soon as it is used; Chrome fires a new one
 * if it offers again later.
 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  notify();
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome === "accepted";
}

/** For useSyncExternalStore: `listener` runs whenever installState() may have changed. */
export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget a captured prompt. */
export function resetInstallPrompt(): void {
  deferred = null;
}
