// The only module that touches PushManager, Notification and PushSubscription.
// Everything reads the browser through a PushEnv so tests pass a fake; the
// database side is lib/api.ts. The browser remembers only its own last
// endpoint (localStorage, a per-viewer convenience): a browser that has been
// denied can no longer read its subscription, and the web never reads an
// endpoint back from the database.

import { listPushDevices, registerPushDevice, reportPushDeviceBlocked, unregisterPushDevice, type PushKeys } from "../lib/api";

export type PushSupport = "unsupported" | "ios-needs-install" | "denied" | "off" | "on";

/** The part of PushSubscription this module uses. */
export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

/** The part of PushManager this module uses. */
export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>;
}

/** What the browser provides; browserEnv() reads the real one. */
export interface PushEnv {
  /** VITE_VAPID_PUBLIC_KEY; empty when the server has no VAPID pair. */
  publicKey: string;
  /** window.Notification, or null where it does not exist. */
  notification: { readonly permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> } | null;
  /** navigator.serviceWorker, or null where it does not exist. */
  serviceWorker: { ready: Promise<{ pushManager: PushManagerLike }> } | null;
  /** "PushManager" in window. */
  pushManager: boolean;
  userAgent: string;
  userAgentData: { brands: Array<{ brand: string }>; platform: string } | null;
  maxTouchPoints: number;
  /** Running as an installed app (display-mode: standalone, or Safari's navigator.standalone). */
  standalone: boolean;
  /** window.localStorage, or null where reading it throws. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** How long to wait for an active service worker; READY_TIMEOUT_MS unless a test shortens it. */
  readyTimeoutMs?: number;
}

export const ENDPOINT_KEY = "longlines.pushEndpoint";
/** serviceWorker.ready never settles when /sw.js failed to register; after this long the browser counts as unsubscribed. */
export const READY_TIMEOUT_MS = 5000;

export const UNSUPPORTED_TEXT = "This browser can't receive push notifications.";
export const DENIED_TEXT = "Notifications are blocked for Long Lines. Allow them in your browser's site settings, then reload this page.";
export const FAILED_TEXT = "Couldn't turn on notifications.";

interface NavigatorWithHints extends Navigator {
  userAgentData?: { brands: Array<{ brand: string }>; platform: string };
  standalone?: boolean;
}

/** The real browser. Every read is guarded: tests run this in node. */
export function browserEnv(): PushEnv {
  const w = typeof window === "undefined" ? null : window;
  const nav = typeof navigator === "undefined" ? null : (navigator as NavigatorWithHints);
  let storage: PushEnv["storage"] = null;
  try {
    storage = w?.localStorage ?? null;
  } catch {
    storage = null;
  }
  return {
    publicKey: (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? "",
    notification: w && "Notification" in w ? w.Notification : null,
    serviceWorker: nav?.serviceWorker ?? null,
    pushManager: w !== null && "PushManager" in w,
    userAgent: nav?.userAgent ?? "",
    userAgentData: nav?.userAgentData ?? null,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    standalone: (w?.matchMedia?.("(display-mode: standalone)").matches ?? false) || nav?.standalone === true,
    storage,
  };
}

// ---- Device descriptors --------------------------------------------------------

const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const BRANDS: Array<[RegExp, string]> = [
  [/Microsoft Edge/i, "Edge"],
  [/Opera/i, "Opera"],
  [/Samsung Internet/i, "Samsung Internet"],
  [/Google Chrome|Chromium/i, "Chrome"],
];

const PLATFORMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"],
];

const HINT_PLATFORMS: Record<string, string> = {
  android: "Android", windows: "Windows", macos: "macOS", linux: "Linux", "chrome os": "ChromeOS", chromeos: "ChromeOS", ios: "iPhone",
};

function browserName(env: PushEnv): string | null {
  for (const { brand } of env.userAgentData?.brands ?? []) {
    const hit = BRANDS.find(([re]) => re.test(brand));
    if (hit) return hit[1];
  }
  return BROWSERS.find(([re]) => re.test(env.userAgent))?.[1] ?? null;
}

function platformName(env: PushEnv): string | null {
  const hint = env.userAgentData?.platform.trim().toLowerCase();
  if (hint && HINT_PLATFORMS[hint]) return HINT_PLATFORMS[hint];
  if (isIos(env)) return /\biPhone\b/.test(env.userAgent) ? "iPhone" : "iPad";
  return PLATFORMS.find(([re]) => re.test(env.userAgent))?.[1] ?? null;
}

/** "{Browser} on {Platform}", or "This browser" when neither is recognisable. */
export function deviceAgent(env: PushEnv = browserEnv()): string {
  const browser = browserName(env);
  const platform = platformName(env);
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? "This browser";
}

/** iPhone, iPad or iPod; iPadOS Safari presents as a Mac with a touch screen. */
export function isIos(env: PushEnv = browserEnv()): boolean {
  return /\b(iPhone|iPad|iPod)\b/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

export function isStandalone(env: PushEnv = browserEnv()): boolean {
  return env.standalone;
}

// ---- The remembered endpoint ----------------------------------------------------

/** The endpoint this browser last registered, or null. */
export function currentEndpoint(env: PushEnv = browserEnv()): string | null {
  try {
    return env.storage?.getItem(ENDPOINT_KEY) ?? null;
  } catch {
    return null;
  }
}

function remember(env: PushEnv, endpoint: string | null): void {
  try {
    if (endpoint) env.storage?.setItem(ENDPOINT_KEY, endpoint);
    else env.storage?.removeItem(ENDPOINT_KEY);
  } catch {
    // Private windows and blocked site data: the endpoint is a convenience only.
  }
}

// ---- State -----------------------------------------------------------------------

function apisPresent(env: PushEnv): env is PushEnv & { notification: NonNullable<PushEnv["notification"]>; serviceWorker: NonNullable<PushEnv["serviceWorker"]> } {
  return env.notification !== null && env.serviceWorker !== null && env.pushManager;
}

type WithWorker = PushEnv & { serviceWorker: NonNullable<PushEnv["serviceWorker"]> };

/** The active registration, or null when none becomes active in time (a failed registration leaves `ready` pending forever). */
async function registration(env: WithWorker): Promise<{ pushManager: PushManagerLike } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), env.readyTimeoutMs ?? READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([env.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function subscription(env: WithWorker): Promise<PushSubscriptionLike | null> {
  const active = await registration(env);
  return active ? active.pushManager.getSubscription() : null;
}

/**
 * What this browser can do: `unsupported` (no push APIs, or no VAPID key on
 * the server), `ios-needs-install` (Safari outside an installed app),
 * `denied`, `on` (granted and subscribed) or `off`.
 */
export async function pushSupport(env: PushEnv = browserEnv()): Promise<PushSupport> {
  if (!env.publicKey) return "unsupported";
  if (isIos(env) && !isStandalone(env)) return "ios-needs-install";
  if (!apisPresent(env)) return "unsupported";
  if (env.notification.permission === "denied") return "denied";
  if (env.notification.permission !== "granted") return "off";
  return (await subscription(env)) ? "on" : "off";
}

function keysOf(sub: PushSubscriptionLike): PushKeys {
  const keys = sub.toJSON().keys ?? {};
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (!p256dh || !auth) throw new Error(FAILED_TEXT);
  return { endpoint: sub.endpoint, p256dh, auth };
}

/** Base64url (the VAPID public key as generated) to the bytes subscribe() takes. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Turns notifications on for this browser and registers it as a device named
 * `label`. Runs on a user gesture: Notification.requestPermission() is the
 * first statement, before any await, because Safari drops the gesture after
 * one. Returns the device id.
 */
export async function enablePush(label: string, env: PushEnv = browserEnv()): Promise<string> {
  const asked = env.notification?.requestPermission();
  if (!asked || !apisPresent(env) || !env.publicKey) throw new Error(UNSUPPORTED_TEXT);
  if ((await asked) !== "granted") throw new Error(DENIED_TEXT);
  const active = await registration(env);
  if (!active) throw new Error(FAILED_TEXT);
  const sub = (await active.pushManager.getSubscription()) ??
    (await active.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(env.publicKey) }));
  const id = await registerPushDevice(keysOf(sub), label, deviceAgent(env), isStandalone(env));
  remember(env, sub.endpoint);
  return id;
}

/**
 * Turns notifications off for this browser: unregisters the device, then
 * unsubscribes. The browser side goes even when the RPC fails (offline, or
 * the account is already gone): a subscription left behind would be
 * registered again on the next load, perhaps for another account on a shared
 * browser, while a row left behind is pruned on its first 410. The failure is
 * still reported.
 */
export async function disablePush(env: PushEnv = browserEnv()): Promise<void> {
  const sub = apisPresent(env) ? await subscription(env) : null;
  const endpoint = sub?.endpoint ?? currentEndpoint(env);
  let failure: Error | null = null;
  if (endpoint) {
    await unregisterPushDevice(endpoint).catch((err: unknown) => {
      failure = err instanceof Error ? err : new Error(String(err));
    });
  }
  if (sub) await sub.unsubscribe();
  remember(env, null);
  if (failure) throw failure;
}

/** disablePush for sign-out: resolves whatever the browser supports or the network does. */
export async function pushCleanup(env: PushEnv = browserEnv()): Promise<void> {
  try {
    await disablePush(env);
  } catch {
    // Best effort: a failed cleanup never keeps the user signed in.
  }
}

/**
 * Once per app load, with a session: a granted and subscribed browser
 * re-registers its keys (the push service may have rotated the endpoint; a
 * null label, agent and standalone keep the device's own), and a denied one
 * reports the endpoint it remembers as blocked. A device this browser
 * registered that the account no longer lists was removed from another
 * device, so the browser follows the removal and unsubscribes instead of
 * creating the device again. Never throws.
 */
export async function refreshPushRegistration(env: PushEnv = browserEnv()): Promise<void> {
  try {
    if (!env.publicKey || !apisPresent(env)) return;
    if (env.notification.permission === "denied") {
      const endpoint = currentEndpoint(env);
      if (endpoint) await reportPushDeviceBlocked(endpoint);
      return;
    }
    if (env.notification.permission !== "granted") return;
    const sub = await subscription(env);
    if (!sub) return;
    const devices = await listPushDevices(sub.endpoint);
    if (!devices.some((d) => d.is_current) && currentEndpoint(env) === sub.endpoint) {
      await sub.unsubscribe();
      remember(env, null);
      return;
    }
    await registerPushDevice(keysOf(sub), null, null, null);
    remember(env, sub.endpoint);
  } catch (err) {
    console.warn("Push registration refresh failed", err);
  }
}
