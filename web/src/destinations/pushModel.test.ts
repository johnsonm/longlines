import { describe, expect, it } from "vitest";
import type { PushDestination, PushField, RecentSpot } from "../lib/api";
import {
  addField, BODY_MAX, blankForm, DEFAULT_SETTINGS, dirty, fieldLabel, formOf, moveField, PUSH_FIELDS, removeField, sendTestBlocker, spotLabel,
  TITLE_MAX, TITLE_MIN, toInput, unpickedFields,
} from "./pushModel";

// Read at transform time by Vite, so the node suite needs no fs access.
const MIGRATIONS: Record<string, string> = import.meta.glob("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The body of the newest definition of a SQL function, up to its closing $$. */
function sqlFunction(name: string): string {
  const head = `create function public.${name}(`;
  const file = Object.keys(MIGRATIONS).sort().filter((f) => MIGRATIONS[f]?.includes(head)).at(-1);
  if (!file) throw new Error(`no migration defines ${name}`);
  const sql = MIGRATIONS[file] ?? "";
  const start = sql.indexOf(head);
  return sql.slice(start, sql.indexOf("$$;", start));
}

/** push_default_settings()'s jsonb_build_object as a plain object. */
function sqlDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of sqlFunction("push_default_settings").matchAll(/'(\w+)', (jsonb_build_array\(([^)]*)\)|'([^']*)'|true|false|\d+)/g)) {
    const [, key, raw, array, text] = m;
    out[key!] = array !== undefined
      ? [...array.matchAll(/'([^']+)'/g)].map((x) => x[1])
      : text !== undefined ? text : raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  return out;
}

describe("the SQL pins", () => {
  it("has the same default settings as push_default_settings()", () => {
    expect(DEFAULT_SETTINGS).toEqual(sqlDefaults());
  });

  it("lists push_fields() in order with push_field_label()'s names", () => {
    const fields = [...(sqlFunction("push_fields").match(/array\[([^\]]+)\]/)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(PUSH_FIELDS.map((f) => f.id)).toEqual(fields);
    const labels = new Map([...sqlFunction("push_field_label").matchAll(/when '(\w+)' then '([^']+)'/g)].map((m) => [m[1], m[2]]));
    for (const f of PUSH_FIELDS) expect(fieldLabel(f.id)).toBe(labels.get(f.id));
  });

  it("keeps decision 4's limits", () => {
    const body = sqlFunction("validate_push_fields");
    expect(body).toContain(`between ${TITLE_MIN} and ${TITLE_MAX}`);
    expect(body).toContain(`> ${BODY_MAX}`);
  });
});

const LIST: PushField[] = ["callsign", "frequency", "mode"];

describe("list edits", () => {
  it("adds a field until the list is full and never twice", () => {
    expect(addField(LIST, "band", TITLE_MAX)).toEqual(["callsign", "frequency", "mode", "band"]);
    expect(addField(LIST, "callsign", TITLE_MAX)).toBe(LIST);
    expect(addField([...LIST, "band"], "state", TITLE_MAX)).toEqual([...LIST, "band"]);
    expect(addField([], "band", BODY_MAX)).toEqual(["band"]);
  });

  it("removes by index but not below the minimum", () => {
    expect(removeField(LIST, 1)).toEqual(["callsign", "mode"]);
    expect(removeField(["callsign"], 0, TITLE_MIN)).toEqual(["callsign"]);
    expect(removeField(["callsign"], 0)).toEqual([]);
    expect(removeField(LIST, 5)).toBe(LIST);
  });

  it("moves a field and refuses to move past the ends", () => {
    expect(moveField(LIST, 0, 1)).toEqual(["frequency", "callsign", "mode"]);
    expect(moveField(LIST, 2, -1)).toEqual(["callsign", "mode", "frequency"]);
    expect(moveField(LIST, 0, -1)).toBe(LIST);
    expect(moveField(LIST, 2, 1)).toBe(LIST);
    expect(moveField(LIST, 1, 0)).toBe(LIST);
  });

  it("lists the unpicked fields in push_fields() order", () => {
    expect(unpickedFields(LIST).map((f) => f.id)).toEqual(["band", "source", "reference", "place_name", "state", "spotter", "comment", "time"]);
  });

  it("labels an unknown field by its id", () => {
    expect(fieldLabel("nope" as PushField)).toBe("nope");
  });
});

const DEST: PushDestination = {
  id: "d1", name: "Phone", enabled: false,
  settings: { ...DEFAULT_SETTINGS, quiet_from: "22:00:00", quiet_until: "07:00:00", urgency: "high" },
  device_ids: ["dev1", "dev2"],
};

describe("the form", () => {
  it("starts blank with the defaults and no devices", () => {
    expect(blankForm()).toEqual({ name: "", enabled: true, settings: DEFAULT_SETTINGS, deviceIds: [] });
    expect(blankForm().settings).not.toBe(DEFAULT_SETTINGS);
  });

  it("loads a destination, trimming SQL's seconds off the quiet times", () => {
    const form = formOf(DEST);
    expect(form).toEqual({
      id: "d1", name: "Phone", enabled: false, settings: { ...DEFAULT_SETTINGS, urgency: "high" }, deviceIds: ["dev1", "dev2"],
    });
    expect(form.deviceIds).not.toBe(DEST.device_ids);
  });

  it("saves the RPC's shape, trimming the name and leaving id out when new", () => {
    expect(toInput({ ...blankForm(), name: "  Phone " })).toEqual({ name: "Phone", enabled: true, settings: DEFAULT_SETTINGS, device_ids: [] });
    expect(toInput(formOf(DEST))).toEqual({
      id: "d1", name: "Phone", enabled: false, settings: { ...DEFAULT_SETTINGS, urgency: "high" }, device_ids: ["dev1", "dev2"],
    });
  });

  it("is dirty when the saved input would change", () => {
    const form = formOf(DEST);
    expect(dirty(form, form)).toBe(false);
    expect(dirty(form, { ...form, name: "Phone " })).toBe(false);
    expect(dirty(form, { ...form, name: "Tablet" })).toBe(true);
    expect(dirty(form, { ...form, deviceIds: ["dev1"] })).toBe(true);
    expect(dirty(form, { ...form, settings: { ...form.settings, sound: false } })).toBe(true);
  });
});

describe("spotLabel", () => {
  const spot = (overrides: Partial<RecentSpot>): RecentSpot => ({
    id: 1, source: "pota", callsign: "KK4PWJ", frequency_khz: 14062, mode: "cw", pota_reference: "US-2763", sota_summit_ref: null,
    wwff_reference: null, spot_time: "2026-10-17T12:00:00Z", band: "20m", mode_family: "cw", comment: null, spotter: "W1AW",
    pota_location: "US-NC", pota_park_name: "Falls Lake", wwff_reference_name: null, ...overrides,
  });

  it("joins call, source and reference, frequency and mode", () => {
    expect(spotLabel(spot({}))).toBe("KK4PWJ, POTA US-2763, 14062 CW");
    expect(spotLabel(spot({ source: "sotawatch", pota_reference: null, sota_summit_ref: "W4C/CM-001", frequency_khz: 7032.5, mode: "ssb" })))
      .toBe("KK4PWJ, SOTAwatch W4C/CM-001, 7032.5 SSB");
    expect(spotLabel(spot({ source: "dxcluster", pota_reference: null, mode: null, frequency_khz: null }))).toBe("KK4PWJ, DX Cluster");
  });
});

describe("sendTestBlocker", () => {
  it("needs a saved destination with members and no unsaved changes", () => {
    expect(sendTestBlocker(undefined, 0, false)).toBe("Add a device to send a test.");
    expect(sendTestBlocker("d1", 0, false)).toBe("Add a device to send a test.");
    expect(sendTestBlocker("d1", 2, true)).toBe("Save your changes to send a test.");
    expect(sendTestBlocker("d1", 2, false)).toBeNull();
  });
});
