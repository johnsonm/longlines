// The service worker, emitted as /sw.js. Push, notification clicks and
// subscription changes only: no fetch handler and no caching, so a deploy can
// never strand anyone on a stale bundle. Behaviour is in sw-handlers.ts.
import { handleNotificationClick, handlePush, handleSubscriptionChange } from "./sw-handlers.ts";

declare const self: ServiceWorkerGlobalScope;

// Nothing is cached, so a new worker can take over at once instead of waiting
// for every window (an installed app is rarely closed) to go away.
void self.skipWaiting();

self.addEventListener("push", (event) => {
  let data: unknown;
  try {
    data = event.data?.json();
  } catch {
    data = undefined;
  }
  event.waitUntil(handlePush(data, self.registration));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event.action, event.notification.data, self.clients, self.location.origin));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // Not in the WebWorker lib's event map yet; the event carries the old subscription.
  const change = event as ExtendableEvent & { oldSubscription?: PushSubscription | null };
  event.waitUntil(handleSubscriptionChange(self.registration, change.oldSubscription ?? null, self.clients));
});
