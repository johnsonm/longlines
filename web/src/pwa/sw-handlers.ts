// The service worker's behaviour as pure functions. They are typed against the
// few members they use rather than the WebWorker lib, so they compile under the
// app tsconfig and run in node tests; sw.ts passes the real objects in. Nothing
// here imports app code or holds a token.

export interface NotificationAction {
  action: "profile" | "source";
  title: string;
}

/** What the sender sends. Fields past `url` are optional; the worker decides, this only displays. */
export interface PushData {
  title: string;
  body: string;
  tag: string;
  url: string;
  sourceUrl?: string;
  actions?: NotificationAction[];
  silent?: boolean;
  renotify?: boolean;
}

/** Stored on the notification for the click handler. */
export interface ClickData {
  url: string;
  sourceUrl?: string;
}

export interface ShownNotificationOptions {
  body: string;
  tag: string;
  data: ClickData;
  icon: string;
  badge: string;
  actions: NotificationAction[];
  silent: boolean;
  renotify: boolean;
}

export interface NotificationTarget {
  showNotification(title: string, options: ShownNotificationOptions): Promise<void>;
}

export interface WindowLike {
  url: string;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface ClientsLike {
  matchAll(options: { type: "window"; includeUncontrolled?: boolean }): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface SubscriptionLike {
  options: { applicationServerKey: ArrayBuffer | null };
}

export interface RegistrationLike {
  pushManager: {
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: ArrayBuffer }): Promise<unknown>;
  };
}

// App code must not import this module: sw.js would then share a chunk with the
// app and stop being standalone (vite.config.ts fails the build). The page
// matches the same string literal.
export const SUBSCRIPTION_CHANGED = "push-subscription-changed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAction(value: unknown): value is NotificationAction {
  return isRecord(value) && (value.action === "profile" || value.action === "source") &&
    typeof value.title === "string";
}

/** Validates a decoded push payload; null when it isn't one the worker sent. */
export function parsePushData(json: unknown): PushData | null {
  if (!isRecord(json)) return null;
  const { title, body, tag, url, sourceUrl, actions, silent, renotify } = json;
  if (typeof title !== "string" || typeof body !== "string" || typeof tag !== "string" || typeof url !== "string") {
    return null;
  }
  return {
    title,
    body,
    tag,
    url,
    sourceUrl: typeof sourceUrl === "string" ? sourceUrl : undefined,
    actions: Array.isArray(actions) ? actions.filter(isAction) : undefined,
    silent: typeof silent === "boolean" ? silent : undefined,
    renotify: typeof renotify === "boolean" ? renotify : undefined,
  };
}

/** `data` is the decoded JSON of the push message (undefined when it had none or wasn't JSON). */
export async function handlePush(data: unknown, notifications: NotificationTarget): Promise<void> {
  const push = parsePushData(data);
  if (!push) return;
  const silent = push.silent ?? false;
  await notifications.showNotification(push.title, {
    body: push.body,
    tag: push.tag,
    data: { url: push.url, sourceUrl: push.sourceUrl },
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    actions: push.actions ?? [],
    silent,
    // A replacement for the same tag alerts again. Browsers throw on renotify
    // with silent or with an empty tag, so it is never sent with either.
    renotify: !silent && push.tag !== "" && (push.renotify ?? true),
  });
}

function clickData(data: unknown): ClickData | null {
  if (!isRecord(data) || typeof data.url !== "string") return null;
  return { url: data.url, sourceUrl: typeof data.sourceUrl === "string" ? data.sourceUrl : undefined };
}

/**
 * Opens the profile, or the source site for the "source" action. A Long Lines
 * page is opened in an existing window when one is open; another site always
 * gets a window of its own, so it never replaces the app.
 */
export async function handleNotificationClick(
  action: string,
  data: unknown,
  clients: ClientsLike,
  origin: string,
): Promise<void> {
  const click = clickData(data);
  if (!click) return;
  let target: URL;
  try {
    target = new URL(action === "source" && click.sourceUrl ? click.sourceUrl : click.url, origin);
  } catch {
    return;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return;
  if (target.origin === origin) {
    // Same-origin windows this worker controls; only those can be navigated.
    const [open] = await clients.matchAll({ type: "window" });
    if (open) {
      try {
        await open.focus();
        await open.navigate(target.href);
        return;
      } catch {
        // The window closed or left this worker's control; open a new one instead.
      }
    }
  }
  await clients.openWindow(target.href);
}

/**
 * The push service replaced or dropped the subscription. Re-subscribe with the
 * same key, then tell every open window so it re-registers the device: the
 * worker has no session to do that itself. With no window open, the next app
 * load re-registers, and the old endpoint is pruned on its first 410.
 */
export async function handleSubscriptionChange(
  registration: RegistrationLike,
  oldSubscription: SubscriptionLike | null,
  clients: ClientsLike,
): Promise<void> {
  const key = oldSubscription?.options.applicationServerKey;
  if (key) {
    try {
      await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch {
      // The window re-subscribes with the app's own key when it gets the message.
    }
  }
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of windows) w.postMessage({ type: SUBSCRIPTION_CHANGED });
}
