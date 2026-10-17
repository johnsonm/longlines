// Pure helpers for the push destination editor: the field list, the default
// settings (pinned to push_default_settings() in SQL by pushModel.test.ts),
// the list edits and the form <-> RPC shapes. The web never renders a field:
// the preview and the delivered text both come from SQL.

import type { PushDestination, PushDestinationInput, PushField, PushSettings, RecentSpot } from "../lib/api";
import { sourceName } from "../sources/sources";
import { spotReference } from "../sources/spots";

export interface FieldInfo {
  id: PushField;
  label: string;
}

/** push_fields() in SQL's order, with push_field_label()'s display names. */
export const PUSH_FIELDS: FieldInfo[] = [
  { id: "callsign", label: "Callsign" },
  { id: "frequency", label: "Frequency" },
  { id: "band", label: "Band" },
  { id: "mode", label: "Mode" },
  { id: "source", label: "Source" },
  { id: "reference", label: "Reference" },
  { id: "place_name", label: "Place name" },
  { id: "state", label: "State" },
  { id: "spotter", label: "Spotter" },
  { id: "comment", label: "Comment" },
  { id: "time", label: "Time" },
];

export function fieldLabel(id: PushField): string {
  return PUSH_FIELDS.find((f) => f.id === id)?.label ?? id;
}

/** Decision 4's limits, checked again in SQL (validate_push_fields). */
export const TITLE_MIN = 1;
export const TITLE_MAX = 4;
export const BODY_MAX = 8;

/** push_default_settings() in SQL; a new destination starts here and Reset returns the field picks to it. */
export const DEFAULT_SETTINGS: PushSettings = {
  title_fields: ["callsign", "frequency", "mode"],
  body_fields: ["source", "reference", "place_name", "state"],
  show_field_names: false,
  body_separator: "dot",
  tap_target: "profile",
  action_buttons: true,
  urgency: "normal",
  ttl_seconds: 1800,
  replace_same_station: true,
  sound: true,
  quiet_enabled: false,
  quiet_from: "22:00",
  quiet_until: "07:00",
  quiet_mode: "silent",
};

export interface Option<T> {
  value: T;
  label: string;
}

export const URGENCIES: Option<PushSettings["urgency"]>[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

/** Drop if the device is offline for: the values push_destination_settings.ttl_seconds accepts. */
export const TTL_OPTIONS: Option<number>[] = [
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 1800, label: "30 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 14400, label: "4 hours" },
];

export const QUIET_MODES: Option<PushSettings["quiet_mode"]>[] = [
  { value: "silent", label: "Send silently" },
  { value: "skip", label: "Don't send" },
];

export const SEPARATORS: Option<PushSettings["body_separator"]>[] = [
  { value: "dot", label: "A dot" },
  { value: "comma", label: "A comma" },
  { value: "newline", label: "A new line" },
];

export const TAP_TARGETS: Option<PushSettings["tap_target"]>[] = [
  { value: "profile", label: "Callsign profile" },
  { value: "source", label: "Source site" },
];

/** Appends a field; the list is returned as is when it is full or already has the field. */
export function addField(list: PushField[], field: PushField, max: number): PushField[] {
  if (list.length >= max || list.includes(field)) return list;
  return [...list, field];
}

/** Removes the field at `index`; the list is returned as is when that would take it below `min`. */
export function removeField(list: PushField[], index: number, min = 0): PushField[] {
  if (index < 0 || index >= list.length || list.length <= min) return list;
  return list.filter((_, i) => i !== index);
}

/** Moves the field at `index` by `delta` places; the list is returned as is when that leaves it. */
export function moveField(list: PushField[], index: number, delta: number): PushField[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length || delta === 0) return list;
  const next = [...list];
  const [field] = next.splice(index, 1);
  next.splice(to, 0, field!);
  return next;
}

/** The fields a list can still take, in push_fields() order. */
export function unpickedFields(list: PushField[]): FieldInfo[] {
  return PUSH_FIELDS.filter((f) => !list.includes(f.id));
}

/** What the editor holds: the RPC's shape, with the device ids the Devices card checks. */
export interface PushForm {
  id?: string;
  name: string;
  enabled: boolean;
  settings: PushSettings;
  deviceIds: string[];
}

export function blankForm(): PushForm {
  return { name: "", enabled: true, settings: { ...DEFAULT_SETTINGS }, deviceIds: [] };
}

/** "22:00:00" (a Postgres time in jsonb) to the "22:00" a time input shows. */
function clock(value: string): string {
  return value.slice(0, 5);
}

export function formOf(dest: PushDestination): PushForm {
  return {
    id: dest.id,
    name: dest.name,
    enabled: dest.enabled,
    settings: { ...dest.settings, quiet_from: clock(dest.settings.quiet_from), quiet_until: clock(dest.settings.quiet_until) },
    deviceIds: [...dest.device_ids],
  };
}

export function toInput(form: PushForm): PushDestinationInput {
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    enabled: form.enabled,
    settings: { ...form.settings },
    device_ids: [...form.deviceIds],
  };
}

/** True when saving `current` would change what `initial` saved. */
export function dirty(initial: PushForm, current: PushForm): boolean {
  return JSON.stringify(toInput(initial)) !== JSON.stringify(toInput(current));
}

/** The preview picker's label for a recent spot: "KK4PWJ, POTA US-2763, 14062 CW". Display only. */
export function spotLabel(spot: RecentSpot): string {
  const where = [sourceName(spot.source ?? ""), spotReference(spot)].filter(Boolean).join(" ");
  const how = [spot.frequency_khz === null ? "" : `${Number(spot.frequency_khz)}`, (spot.mode ?? "").toUpperCase()].filter(Boolean).join(" ");
  return [spot.callsign ?? "", where, how].filter(Boolean).join(", ");
}
