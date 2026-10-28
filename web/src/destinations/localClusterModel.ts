// Pure helpers for the Local DX cluster destination editor and its list card:
// the field list, the default settings (pinned to local_cluster_default_settings()
// in SQL by localClusterModel.test.ts), the relay choices and the form <-> RPC
// shapes. The web never renders a spot line: the preview and the delivered
// spot come from SQL.

import type {
  LocalClusterDestination, LocalClusterDestinationInput, LocalClusterField, LocalClusterSettings, LocalClusterSettingsSummary, RelayToken,
} from "../lib/api";
import { SPOTS_READ } from "../relay/model";
import type { FieldInfo } from "./fieldList";

export { SPOTS_READ };

/** local_cluster_fields() in SQL's order, with the editor's names (DestinationDxCluster). */
export const LOCAL_CLUSTER_FIELDS: FieldInfo<LocalClusterField>[] = [
  { id: "reference", label: "Reference" },
  { id: "source", label: "Source" },
  { id: "comment", label: "Spotter's comment" },
];

/** Each field's line under its name in the Spot line card. */
export const FIELD_HELP: Record<LocalClusterField, string> = {
  reference: "POTA park or SOTA summit, like K-0039",
  source: "Where the spot came from, like POTA or RBN",
  comment: "The note the spotter added, when there is one",
};

/** Every field at most once; SQL checks the list again on save (validate_local_cluster_fields). */
export const MAX_FIELDS = LOCAL_CLUSTER_FIELDS.length;

/** local_cluster_default_settings() in SQL; a new destination starts here. */
export const DEFAULT_SETTINGS: { fields: LocalClusterField[] } = { fields: ["reference"] };

/** What the editor holds. */
export interface LocalClusterForm {
  id?: string;
  name: string;
  enabled: boolean;
  /** The chosen relay token, or null until one is picked (or after the saved one was revoked). */
  relayId: string | null;
  fields: LocalClusterField[];
}

/** A new destination: no relay yet, the default fields. */
export function blankForm(): LocalClusterForm {
  return { name: "", enabled: true, relayId: null, fields: [...DEFAULT_SETTINGS.fields] };
}

/** A saved destination as get_local_cluster_destination returns it. */
export function formOf(dest: LocalClusterDestination): LocalClusterForm {
  return { id: dest.id, name: dest.name, enabled: dest.enabled, relayId: dest.settings.relay_id, fields: [...dest.settings.fields] };
}

/** The settings the RPCs take. */
export function settingsOf(form: LocalClusterForm): LocalClusterSettings {
  return { relay_id: form.relayId, fields: [...form.fields] };
}

/** The save RPC's shape: the name trimmed. */
export function toInput(form: LocalClusterForm): LocalClusterDestinationInput {
  return { ...(form.id ? { id: form.id } : {}), name: form.name.trim(), enabled: form.enabled, settings: settingsOf(form) };
}

const PLATFORMS: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

/** "Shack PC · Windows"; a relay that never said its platform (v1) is just its name. */
export function relayLabel(relay: Pick<RelayToken, "device_name" | "platform">): string {
  const platform = relay.platform === null ? undefined : PLATFORMS[relay.platform];
  return platform ? `${relay.device_name} · ${platform}` : relay.device_name;
}

/**
 * The relays the editor offers: those signed in with spots:read, since a relay
 * without it can never open its spots stream (it has to sign in again). The
 * saved relay stays in the list either way, so the select never loses its value.
 */
export function relayChoices(relays: RelayToken[], keepId: string | null): RelayToken[] {
  return relays.filter((r) => r.scopes.includes(SPOTS_READ) || r.id === keepId);
}

/** The relay a new destination starts on: the first one it can use, or none. */
export function firstRelay(relays: RelayToken[]): string | null {
  return relays.find((r) => r.scopes.includes(SPOTS_READ))?.id ?? null;
}

/** The list card's type line: "Local DX cluster · Shack PC", or the bare type until the summary loads or once its relay is revoked. */
export function localClusterCardLine(summary: LocalClusterSettingsSummary | null): string {
  return summary?.device_name ? `Local DX cluster · ${summary.device_name}` : "Local DX cluster";
}

/** True when the card should say Relay offline: its summary loaded and no spots stream is open (or the relay is gone). */
export function relayOffline(summary: LocalClusterSettingsSummary | null): boolean {
  return summary !== null && summary.cluster_connected_at === null;
}

/** The preview's Time (UTC) row: SQL's "2114" as "21:14". */
export function clusterTime(hhmm: string): string {
  return /^\d{4}$/.test(hhmm) ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : hhmm;
}

/** The preview's Frequency row: SQL's kHz with one decimal, as the line shows it. */
export function clusterFrequency(khz: number): string {
  return `${khz.toFixed(1)} kHz`;
}
