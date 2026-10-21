// Pure helpers for the Discord destination editor: the field list, the limits,
// the default settings (pinned to discord_default_settings() in SQL by
// discordModel.test.ts), the option lists and the form <-> RPC shapes. The web
// never renders a field: the preview and the delivered message come from SQL.

import type { DiscordDestination, DiscordDestinationInput, DiscordField, DiscordSettings } from "../lib/api";
import type { FieldInfo, Option } from "./fieldList";

/** discord_fields() in SQL's order: push_fields() minus comment, with push_field_label()'s names. */
export const DISCORD_FIELDS: FieldInfo<DiscordField>[] = [
  { id: "callsign", label: "Callsign" },
  { id: "first_name", label: "First name" },
  { id: "last_name", label: "Last name" },
  { id: "frequency", label: "Frequency" },
  { id: "band", label: "Band" },
  { id: "mode", label: "Mode" },
  { id: "source", label: "Source" },
  { id: "reference", label: "Reference" },
  { id: "place_name", label: "Place name" },
  { id: "state", label: "State" },
  { id: "spotter", label: "Spotter" },
  { id: "time", label: "Time" },
];

/** Decision 4's limits, checked again in SQL (validate_discord_fields). */
export const TITLE_MIN = 1;
export const TITLE_MAX = 4;
export const DETAILS_MAX = 8;
export const GRID_MAX = 6;
export const LINE_MIN = 1;
export const LINE_MAX = 8;

/** discord_default_settings() in SQL; a new destination starts here and Reset returns the four field lists to it. */
export const DEFAULT_SETTINGS: DiscordSettings = {
  style: "card",
  title_fields: ["callsign", "frequency", "mode"],
  detail_fields: ["source", "reference", "place_name", "state"],
  grid_fields: ["band", "spotter"],
  title_link: "profile",
  card_color: "source",
  footer: true,
  line_fields: ["callsign", "frequency", "mode", "source", "reference", "place_name"],
  bold_first: true,
  link_preview: "hidden",
  show_field_names: false,
  separator: "dot",
  batch_seconds: 0,
};

/** The four field lists at their defaults, for Reset to default fields. */
export function defaultFields(): Pick<DiscordSettings, "title_fields" | "detail_fields" | "grid_fields" | "line_fields"> {
  return {
    title_fields: [...DEFAULT_SETTINGS.title_fields],
    detail_fields: [...DEFAULT_SETTINGS.detail_fields],
    grid_fields: [...DEFAULT_SETTINGS.grid_fields],
    line_fields: [...DEFAULT_SETTINGS.line_fields],
  };
}

/** Message style: a label and a helper per option. */
export interface StyleOption extends Option<DiscordSettings["style"]> {
  help: string;
}

export const STYLES: StyleOption[] = [
  { value: "card", label: "Card", help: "A colored card with a title, details and a small grid. Easiest to scan." },
  { value: "plain", label: "Plain line", help: "One line of text, like a chat message. Takes the least space." },
];

export const TITLE_LINKS: Option<DiscordSettings["title_link"]>[] = [
  { value: "profile", label: "Callsign profile" },
  { value: "source", label: "Source site" },
  { value: "none", label: "Nothing" },
];

export const CARD_COLORS: Option<DiscordSettings["card_color"]>[] = [
  { value: "source", label: "By source" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "purple", label: "Purple" },
  { value: "orange", label: "Orange" },
  { value: "red", label: "Red" },
  { value: "grey", label: "Grey" },
];

export const SEPARATORS: Option<DiscordSettings["separator"]>[] = [
  { value: "dot", label: "A dot" },
  { value: "comma", label: "A comma" },
  { value: "newline", label: "A new line" },
];

export const LINK_PREVIEWS: Option<DiscordSettings["link_preview"]>[] = [
  { value: "hidden", label: "Hidden" },
  { value: "shown", label: "Shown" },
];

/** Decision 13's Messages labels: the values discord_destination_settings.batch_seconds accepts. */
export const BATCH_OPTIONS: Option<number>[] = [
  { value: 0, label: "One message per spot" },
  { value: 10, label: "Group spots every 10 seconds" },
  { value: 30, label: "Group spots every 30 seconds" },
  { value: 60, label: "Group spots every 60 seconds" },
];

/** What the editor holds. `url` is the Webhook URL field: null while it is closed (keep the stored URL). */
export interface DiscordForm {
  id?: string;
  name: string;
  enabled: boolean;
  url: string | null;
  settings: DiscordSettings;
}

/** A new destination: the URL field open and empty, the defaults. */
export function blankForm(): DiscordForm {
  return { name: "", enabled: true, url: "", settings: defaultSettingsCopy() };
}

function defaultSettingsCopy(): DiscordSettings {
  return { ...DEFAULT_SETTINGS, ...defaultFields() };
}

/** A saved destination: the URL field closed, since get_discord_destination never returns the URL. */
export function formOf(dest: DiscordDestination): DiscordForm {
  return {
    id: dest.id,
    name: dest.name,
    enabled: dest.enabled,
    url: null,
    settings: {
      ...dest.settings,
      title_fields: [...dest.settings.title_fields],
      detail_fields: [...dest.settings.detail_fields],
      grid_fields: [...dest.settings.grid_fields],
      line_fields: [...dest.settings.line_fields],
    },
  };
}

/** The RPC's shape: the name and URL trimmed, an empty URL sent as null (keep the stored one). */
export function toInput(form: DiscordForm): DiscordDestinationInput {
  const url = form.url?.trim() ?? "";
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    enabled: form.enabled,
    url: url === "" ? null : url,
    settings: { ...form.settings },
  };
}

/** True when saving `current` would change what `initial` saved. */
export function dirty(initial: DiscordForm, current: DiscordForm): boolean {
  return JSON.stringify(toInput(initial)) !== JSON.stringify(toInput(current));
}

const WEBHOOK_PREFIXES = ["https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/"];

/** A client-side hint for the Webhook URL field's error helper; SQL (validate_destination_url) decides. */
export function looksLikeWebhookUrl(value: string): boolean {
  const url = value.trim();
  return WEBHOOK_PREFIXES.some((p) => url.startsWith(p) && url.length > p.length);
}

/** Why Send test is disabled, or null when the test can go (it uses the saved URL and settings). */
export function sendTestBlocker(destinationId: string | undefined, hasUrl: boolean, isDirty: boolean): string | null {
  if (!hasUrl) return "Add a webhook URL to send a test.";
  if (!destinationId || isDirty) return "Save your changes to send a test.";
  return null;
}

/** The destination card's type line: "Discord channel · Card · 9 fields" or "Discord channel · Plain line · 6 fields". */
export function discordCardLine(style: DiscordSettings["style"], count: number): string {
  const label = STYLES.find((s) => s.value === style)?.label ?? style;
  return `Discord channel · ${label} · ${count} field${count === 1 ? "" : "s"}`;
}
