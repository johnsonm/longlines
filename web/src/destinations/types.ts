import type { DestinationType } from "../lib/api";

/** The types a user can add, in the order the picker shows them. Data, so a new type is one more entry. */
export const DEST_TYPES: Array<{ id: DestinationType; label: string; help: string }> = [
  { id: "discord", label: "Discord channel", help: "Post each spot to a channel through a webhook." },
  { id: "webhook", label: "Webhook", help: "Send each spot as JSON to your own URL." },
  { id: "push", label: "Push notification", help: "Notify your phone or computer. Works in the browser, no app to install." },
];

export function typeLabel(id: string): string {
  return DEST_TYPES.find((t) => t.id === id)?.label ?? id;
}
