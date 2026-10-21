// Pure helpers for the webhook destination editor: the field catalog, the
// limits, the default settings (pinned to webhook_default_settings() in SQL by
// webhookModel.test.ts), the key names for display, the option lists, the
// form <-> RPC shapes and the extra header rows. The web never renders a
// value: the preview and the delivered body come from SQL.

import type {
  WebhookDestination, WebhookDestinationInput, WebhookField, WebhookHeaderInput, WebhookSettings,
} from "../lib/api";
import type { FieldInfo, Option } from "./fieldList";

export { sendTestBlocker } from "./discordModel";

/** webhook_fields() in SQL's order, with the spec's labels (decision 6). */
export const WEBHOOK_FIELDS: FieldInfo<WebhookField>[] = [
  { id: "id", label: "Spot ID" },
  { id: "time", label: "Time" },
  { id: "callsign", label: "Callsign" },
  { id: "first_name", label: "First name" },
  { id: "last_name", label: "Last name" },
  { id: "frequency", label: "Frequency" },
  { id: "mode", label: "Mode" },
  { id: "band", label: "Band" },
  { id: "source", label: "Source" },
  { id: "reference", label: "Reference" },
  { id: "place_name", label: "Place name" },
  { id: "state", label: "State" },
  { id: "spotter", label: "Spotter" },
  { id: "country", label: "Country" },
  { id: "url", label: "Spot URL" },
  { id: "comment", label: "Comment (free text)" },
];

/** webhook_fields_valid()'s limits, checked again in SQL. */
export const FIELDS_MIN = 1;
export const FIELDS_MAX = 16;

/** Extra headers per destination, checked again in SQL (set_webhook_headers). */
export const HEADERS_MAX = 10;

/** The failed requests that pause a destination when the switch is on; off is null. */
export const PAUSE_AFTER = 20;

/** webhook_default_settings() in SQL; a new destination starts here and Reset returns `fields` to it. */
export const DEFAULT_WEBHOOK_SETTINGS: WebhookSettings = {
  fields: ["id", "time", "callsign", "frequency", "mode", "band", "source", "reference", "place_name", "state", "spotter"],
  key_style: "snake",
  time_format: "iso_utc",
  frequency_unit: "khz",
  missing_values: "omit",
  batch_seconds: 0,
  retry_policy: "three_10m",
  pause_after_failures: PAUSE_AFTER,
};

/** The field list at its default, for Reset to default fields (the selects keep their choices). */
export function defaultFields(): WebhookField[] {
  return [...DEFAULT_WEBHOOK_SETTINGS.fields];
}

/**
 * The key a field goes out under, as webhook_field_key() names it: the
 * frequency key carries the unit, and camelCase changes only placeName,
 * firstName, lastName and the frequency. For display only; SQL names the keys
 * of every request.
 */
export function webhookKey(field: WebhookField, keyStyle: WebhookSettings["key_style"], unit: WebhookSettings["frequency_unit"]): string {
  if (field === "frequency") return keyStyle === "camel" ? `frequency${unit[0]!.toUpperCase()}${unit.slice(1)}` : `frequency_${unit}`;
  if (keyStyle === "camel") {
    if (field === "place_name") return "placeName";
    if (field === "first_name") return "firstName";
    if (field === "last_name") return "lastName";
  }
  return field;
}

export const KEY_STYLES: Option<WebhookSettings["key_style"]>[] = [
  { value: "snake", label: "snake_case" },
  { value: "camel", label: "camelCase" },
];

export const TIME_FORMATS: Option<WebhookSettings["time_format"]>[] = [
  { value: "iso_utc", label: "ISO 8601, UTC" },
  { value: "unix_seconds", label: "Unix seconds" },
];

export const FREQUENCY_UNITS: Option<WebhookSettings["frequency_unit"]>[] = [
  { value: "khz", label: "kHz" },
  { value: "mhz", label: "MHz" },
  { value: "hz", label: "Hz" },
];

export const MISSING_VALUES: Option<WebhookSettings["missing_values"]>[] = [
  { value: "omit", label: "Leave the key out" },
  { value: "null", label: "Send null" },
];

/** The Requests select: the values webhook_destination_settings.batch_seconds accepts. */
export const REQUEST_OPTIONS: Option<number>[] = [
  { value: 0, label: "One request per spot" },
  { value: 10, label: "Group spots every 10 seconds" },
  { value: 30, label: "Group spots every 30 seconds" },
  { value: 60, label: "Group spots every 60 seconds" },
];

export const RETRY_POLICIES: Option<WebhookSettings["retry_policy"]>[] = [
  { value: "none", label: "Don't retry" },
  { value: "three_10m", label: "Up to 3 times over 10 minutes" },
  { value: "day", label: "Keep trying for 24 hours" },
];

/** The Time format helper: an example in the chosen format (decision 18). */
export function timeExample(format: WebhookSettings["time_format"]): string {
  return format === "unix_seconds" ? "1792258929" : "2026-10-17T17:42:09Z";
}

/** The missing-value helper names the other choice (decision 18). */
export function missingHelper(value: WebhookSettings["missing_values"]): string {
  return value === "null" ? "Or leave the key out." : "Or send null.";
}

/** The Requests helper names the other choice (decision 18). */
export function requestsHelper(batchSeconds: number): string {
  return batchSeconds === 0
    ? "Or group spots into one request every 10, 30 or 60 seconds. Grouped requests send a spots list instead of a single spot."
    : "Or send one request per spot. Grouped requests send a spots list instead of a single spot.";
}

/**
 * One row of the Extra headers list. `saved` is the stored name a row was
 * loaded with (null for a row added here); `value` is what was typed, never a
 * stored value, which the editor never receives. `key` is for React only.
 */
export interface HeaderRow {
  key: string;
  name: string;
  value: string;
  saved: string | null;
}

let nextHeaderKey = 0;
function headerKey(): string {
  nextHeaderKey += 1;
  return `header-${nextHeaderKey}`;
}

/** Appends an empty row; the rows are returned as is at HEADERS_MAX. */
export function addHeader(rows: HeaderRow[]): HeaderRow[] {
  if (rows.length >= HEADERS_MAX) return rows;
  return [...rows, { key: headerKey(), name: "", value: "", saved: null }];
}

export function removeHeader(rows: HeaderRow[], key: string): HeaderRow[] {
  return rows.filter((r) => r.key !== key);
}

export function updateHeader(rows: HeaderRow[], key: string, patch: Partial<Pick<HeaderRow, "name" | "value">>): HeaderRow[] {
  return rows.map((r) => (r.key === key ? { ...r, ...patch } : r));
}

/** A row with nothing typed in it, which a save leaves out. */
function blankRow(row: HeaderRow): boolean {
  return row.saved === null && row.name.trim() === "" && row.value === "";
}

/**
 * True when a row has a name but SQL would refuse it for want of a value
 * ("Give the {name} header a value."): a new row, or a saved one renamed
 * (other than in case), with nothing typed. A client-side hint; SQL decides.
 */
export function headerNeedsValue(row: HeaderRow): boolean {
  const name = row.name.trim();
  if (name === "" || row.value !== "") return false;
  return row.saved === null || row.saved.toLowerCase() !== name.toLowerCase();
}

/** A row as set_webhook_headers takes it: the value only when one was typed, so a saved row keeps its stored value. */
export function headerInput(row: HeaderRow): WebhookHeaderInput {
  const name = row.name.trim();
  return row.value === "" ? { name } : { name, value: row.value };
}

/** What the editor holds. `url` is the Webhook URL field: null while it is closed (keep the stored URL). */
export interface WebhookForm {
  id?: string;
  name: string;
  enabled: boolean;
  url: string | null;
  settings: WebhookSettings;
  headers: HeaderRow[];
}

function defaultSettingsCopy(): WebhookSettings {
  return { ...DEFAULT_WEBHOOK_SETTINGS, fields: defaultFields() };
}

/** A new destination: the URL field open and empty, the defaults, no headers. */
export function blankForm(): WebhookForm {
  return { name: "", enabled: true, url: "", settings: defaultSettingsCopy(), headers: [] };
}

/** A saved destination: the URL field closed and each header by name only, since get_webhook_destination returns neither URL nor values. */
export function formOf(dest: WebhookDestination): WebhookForm {
  return {
    id: dest.id,
    name: dest.name,
    enabled: dest.enabled,
    url: null,
    settings: { ...dest.settings, fields: [...dest.settings.fields] },
    headers: dest.headers.map((h) => ({ key: headerKey(), name: h.name, value: "", saved: h.name })),
  };
}

/**
 * The RPC's shape: the name and URL trimmed, an empty URL sent as null (keep the stored one), empty new header rows left out.
 * With `loaded`, a saved destination's Enabled goes as null (keep) unless the switch now differs from what was loaded:
 * update_destination reads Enabled on as a resume, so a pause that lands while the editor is open must not be cleared
 * by a save that never touched the switch (decision 4).
 */
export function toInput(form: WebhookForm, loaded?: WebhookForm): WebhookDestinationInput {
  const url = form.url?.trim() ?? "";
  const keepEnabled = form.id !== undefined && loaded !== undefined && loaded.enabled === form.enabled;
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    enabled: keepEnabled ? null : form.enabled,
    url: url === "" ? null : url,
    settings: { ...form.settings, fields: [...form.settings.fields] },
    headers: form.headers.filter((r) => !blankRow(r)).map(headerInput),
  };
}

/** True when saving `current` would change what `initial` saved. */
export function dirty(initial: WebhookForm, current: WebhookForm): boolean {
  return JSON.stringify(toInput(initial)) !== JSON.stringify(toInput(current));
}

/** The destination card's type line: "Webhook · 11 fields" or "Webhook · 5 fields · grouped every 30 seconds" (decision 17). */
export function webhookCardLine(count: number, batchSeconds: number): string {
  const fields = `Webhook · ${count} field${count === 1 ? "" : "s"}`;
  return batchSeconds > 0 ? `${fields} · grouped every ${batchSeconds} seconds` : fields;
}

/**
 * The path in the preview's request line (decision 8): the typed URL's on a
 * new destination or while replacing, else the masked url_display's, so
 * `POST /hook/••••••`. Cut by hand rather than with URL, which would
 * percent-encode the mask. "/" when there is neither.
 */
export function requestPath(typed: string | null, urlDisplay: string | null): string {
  const url = typed?.trim() || urlDisplay || "";
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").replace(/#.*$/, "");
  if (rest === "") return "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** The headers every request carries, in the order sent after Host (decision 19). `now` is Unix seconds. */
export function fixedHeaderLines(now: number): string[] {
  return [
    "Accept: */*",
    "Content-Type: application/json",
    "User-Agent: LongLines/0.2",
    `X-LongLines-Timestamp: ${now}`,
    "X-LongLines-Signature: sha256=…",
  ];
}

/** An extra header in the preview: its name with the value masked. Rows without a name are left out. */
export function extraHeaderLines(rows: HeaderRow[]): string[] {
  return rows.map((r) => r.name.trim()).filter((n) => n !== "").map((n) => `${n}: ••••••••`);
}

/** A header row SQL would refuse for want of a name: a saved row cleared, or a value typed with no name. */
export function headerNeedsName(row: HeaderRow): boolean {
  return row.name.trim() === "" && (row.saved !== null || row.value !== "");
}

/** The "Destination added" dialog's sentence, which says how requests come (Copy). */
export function createdSentence(name: string, batchSeconds: number): string {
  return batchSeconds > 0
    ? `${name} will receive a request every ${batchSeconds} seconds with the matching spots, with the fields you chose.`
    : `${name} will receive a request for each matching spot, with the fields you chose.`;
}

/** The editor checks only the scheme ("Must start with https://"); validate_destination_url decides the rest on save. */
export function looksLikeHttpsUrl(url: string): boolean {
  return /^https:\/\/\S+$/i.test(url.trim());
}

/**
 * The receiver's status from a failed Send test (send-test's 502 carries it as ApiError.receiverStatus),
 * or null when there is none, such as a refused connection. Read by shape so a mocked api module still works.
 */
export function answeredStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("receiverStatus" in err)) return null;
  const status = (err as { receiverStatus: unknown }).receiverStatus;
  return typeof status === "number" ? status : null;
}
