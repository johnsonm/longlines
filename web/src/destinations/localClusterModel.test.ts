import { describe, expect, it } from "vitest";
import type { LocalClusterSettingsSummary, RelayToken } from "../lib/api";
import {
  blankForm, clusterFrequency, clusterTime, DEFAULT_SETTINGS, FIELD_HELP, firstRelay, formOf, LOCAL_CLUSTER_FIELDS, localClusterCardLine,
  MAX_FIELDS, relayChoices, relayLabel, relayOffline, settingsOf, SPOTS_READ, toInput,
} from "./localClusterModel";

// Read at transform time by Vite, so the node suite needs no fs access.
const MIGRATIONS: Record<string, string> = import.meta.glob("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The body of the newest definition of a SQL function, up to its closing $$. */
function sqlFunction(name: string): string {
  const head = new RegExp(`create (or replace )?function public\\.${name}\\(`);
  const file = Object.keys(MIGRATIONS).sort().filter((f) => head.test(MIGRATIONS[f] ?? "")).at(-1);
  if (!file) throw new Error(`no migration defines ${name}`);
  const sql = MIGRATIONS[file] ?? "";
  const start = sql.search(head);
  return sql.slice(start, sql.indexOf("$$;", start));
}

function relay(id: string, overrides: Partial<RelayToken> = {}): RelayToken {
  return {
    id, user_id: "u1", token_prefix: "llr_abc", device_name: `Relay ${id}`, client_version: "0.2.0", scopes: ["contacts:write", SPOTS_READ],
    created_at: "2026-10-28T00:00:00Z", last_used_at: null, platform: "windows", cluster_connected_at: null, ...overrides,
  };
}

function summary(overrides: Partial<LocalClusterSettingsSummary> = {}): LocalClusterSettingsSummary {
  return {
    destination_id: "l1", relay_id: "r1", device_name: "Shack PC", platform: "windows", cluster_connected_at: null, fields: ["reference"],
    ...overrides,
  };
}

describe("the SQL pins", () => {
  it("has the same default settings as local_cluster_default_settings()", () => {
    const literal = /select '(.*)'::jsonb/.exec(sqlFunction("local_cluster_default_settings"))?.[1];
    expect(literal).toBeDefined();
    expect(DEFAULT_SETTINGS).toEqual(JSON.parse(literal!));
  });

  it("lists local_cluster_fields() in SQL's order", () => {
    const array = /array\[([^\]]*)\]/.exec(sqlFunction("local_cluster_fields"))?.[1] ?? "";
    expect(LOCAL_CLUSTER_FIELDS.map((f) => f.id)).toEqual([...array.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    expect(MAX_FIELDS).toBe(3);
  });

  it("names the scope relay_scopes() allows", () => {
    expect(sqlFunction("relay_scopes")).toContain(`'${SPOTS_READ}'`);
  });
});

describe("the field list", () => {
  it("names and describes each field as the editor does", () => {
    expect(LOCAL_CLUSTER_FIELDS.map((f) => f.label)).toEqual(["Reference", "Source", "Spotter's comment"]);
    expect(FIELD_HELP).toEqual({
      reference: "POTA park or SOTA summit, like K-0039",
      source: "Where the spot came from, like POTA or RBN",
      comment: "The note the spotter added, when there is one",
    });
  });
});

describe("the form", () => {
  it("starts with no relay and a copy of the default fields", () => {
    const form = blankForm();
    expect(form).toEqual({ name: "", enabled: true, relayId: null, fields: ["reference"] });
    form.fields.push("source");
    expect(DEFAULT_SETTINGS.fields).toEqual(["reference"]);
  });

  it("round-trips a saved destination into the save RPC's shape", () => {
    const form = formOf({
      id: "l1", name: " Shack bandmap ", enabled: false, url_display: "Long Lines Relay", settings: { relay_id: "r1", fields: ["comment", "reference"] },
    });
    expect(form).toEqual({ id: "l1", name: " Shack bandmap ", enabled: false, relayId: "r1", fields: ["comment", "reference"] });
    expect(toInput(form)).toEqual({ id: "l1", name: "Shack bandmap", enabled: false, settings: { relay_id: "r1", fields: ["comment", "reference"] } });
    expect(toInput(blankForm())).toEqual({ name: "", enabled: true, settings: { relay_id: null, fields: ["reference"] } });
    expect(settingsOf(form)).toEqual({ relay_id: "r1", fields: ["comment", "reference"] });
  });
});

describe("relays", () => {
  it("labels a relay with its platform, or its name alone", () => {
    expect(relayLabel(relay("r1", { device_name: "Shack PC" }))).toBe("Shack PC · Windows");
    expect(relayLabel(relay("r1", { device_name: "Laptop", platform: "macos" }))).toBe("Laptop · macOS");
    expect(relayLabel(relay("r1", { device_name: "Pi", platform: "linux" }))).toBe("Pi · Linux");
    expect(relayLabel(relay("r1", { device_name: "Old PC", platform: null }))).toBe("Old PC");
    expect(relayLabel(relay("r1", { device_name: "Odd", platform: "beos" }))).toBe("Odd");
  });

  it("offers only relays that can receive spots, keeping the saved one", () => {
    const v1 = relay("v1", { scopes: ["contacts:write"], platform: null });
    const v2 = relay("v2");
    expect(relayChoices([v1, v2], null)).toEqual([v2]);
    expect(relayChoices([v1, v2], "v1")).toEqual([v1, v2]);
    expect(firstRelay([v1, v2])).toBe("v2");
    expect(firstRelay([v1])).toBeNull();
  });
});

describe("the card", () => {
  it("names the relay in the type line", () => {
    expect(localClusterCardLine(summary())).toBe("Local DX cluster · Shack PC");
    expect(localClusterCardLine(summary({ relay_id: null, device_name: null }))).toBe("Local DX cluster");
    expect(localClusterCardLine(null)).toBe("Local DX cluster");
  });

  it("is offline only once the summary says no stream is open", () => {
    expect(relayOffline(null)).toBe(false);
    expect(relayOffline(summary())).toBe(true);
    expect(relayOffline(summary({ cluster_connected_at: "2026-10-28T21:00:00Z" }))).toBe(false);
  });
});

describe("the preview rows", () => {
  it("formats SQL's time and frequency as the line shows them", () => {
    expect(clusterTime("2114")).toBe("21:14");
    expect(clusterTime("0005")).toBe("00:05");
    expect(clusterTime("bad")).toBe("bad");
    expect(clusterFrequency(14062)).toBe("14062.0 kHz");
    expect(clusterFrequency(7074.5)).toBe("7074.5 kHz");
  });
});
