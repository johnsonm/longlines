import { describe, expect, it } from "vitest";
import type { DiscordDestination } from "../lib/api";
import {
  BATCH_OPTIONS, blankForm, CARD_COLORS, DEFAULT_SETTINGS, defaultFields, DETAILS_MAX, dirty, DISCORD_FIELDS, discordCardLine, discordPausedLine,
  formOf, GRID_MAX, LINE_MAX, LINE_MIN, LINK_PREVIEWS, looksLikeWebhookUrl, sendTestBlocker, SEPARATORS, STYLES, TITLE_LINKS, TITLE_MAX,
  TITLE_MIN, toInput,
} from "./discordModel";
import { PUSH_FIELDS } from "./pushModel";

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

/** discord_default_settings()'s jsonb_build_object as a plain object. */
function sqlDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of sqlFunction("discord_default_settings").matchAll(/'(\w+)', (jsonb_build_array\(([^)]*)\)|'([^']*)'|true|false|\d+)/g)) {
    const [, key, raw, array, text] = m;
    out[key!] = array !== undefined
      ? [...array.matchAll(/'([^']+)'/g)].map((x) => x[1])
      : text !== undefined ? text : raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  return out;
}

describe("the SQL pins", () => {
  it("has the same default settings as discord_default_settings()", () => {
    expect(DEFAULT_SETTINGS).toEqual(sqlDefaults());
  });

  it("lists discord_fields(): push's fields and names in push's order, minus comment", () => {
    expect(sqlFunction("discord_fields")).toContain("array_remove(public.push_fields(), 'comment')");
    expect(DISCORD_FIELDS).toEqual(PUSH_FIELDS.filter((f) => f.id !== "comment"));
  });

  it("keeps decision 4's limits", () => {
    const body = sqlFunction("validate_discord_fields");
    expect(body).toContain(`'title' and (p_fields is null or v_count not between ${TITLE_MIN} and ${TITLE_MAX})`);
    expect(body).toContain(`'details' and (p_fields is null or v_count > ${DETAILS_MAX})`);
    expect(body).toContain(`'grid' and (p_fields is null or v_count > ${GRID_MAX})`);
    expect(body).toContain(`'line' and (p_fields is null or v_count not between ${LINE_MIN} and ${LINE_MAX})`);
  });
});

describe("the field list and options", () => {
  it("has twelve fields with push's labels and no comment", () => {
    expect(DISCORD_FIELDS.map((f) => f.id)).toEqual([
      "callsign", "first_name", "last_name", "frequency", "band", "mode", "source", "reference", "place_name", "state", "spotter", "time",
    ]);
  });

  it("keeps the defaults inside the limits", () => {
    expect(DEFAULT_SETTINGS.title_fields.length).toBeGreaterThanOrEqual(TITLE_MIN);
    expect(DEFAULT_SETTINGS.title_fields.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(DEFAULT_SETTINGS.detail_fields.length).toBeLessThanOrEqual(DETAILS_MAX);
    expect(DEFAULT_SETTINGS.grid_fields.length).toBeLessThanOrEqual(GRID_MAX);
    expect(DEFAULT_SETTINGS.line_fields.length).toBeGreaterThanOrEqual(LINE_MIN);
    expect(DEFAULT_SETTINGS.line_fields.length).toBeLessThanOrEqual(LINE_MAX);
  });

  it("labels the options as the spec's Copy does", () => {
    expect(STYLES).toEqual([
      { value: "card", label: "Card", help: "A colored card with a title, details and a small grid. Easiest to scan." },
      { value: "plain", label: "Plain line", help: "One line of text, like a chat message. Takes the least space." },
    ]);
    expect(TITLE_LINKS.map((o) => o.label)).toEqual(["Callsign profile", "Source site", "Nothing"]);
    expect(CARD_COLORS.map((o) => o.label)).toEqual(["By source", "Blue", "Green", "Purple", "Orange", "Red", "Grey"]);
    expect(CARD_COLORS.map((o) => o.value)).toEqual(["source", "blue", "green", "purple", "orange", "red", "grey"]);
    expect(SEPARATORS.map((o) => o.label)).toEqual(["A dot", "A comma", "A new line"]);
    expect(LINK_PREVIEWS).toEqual([{ value: "hidden", label: "Hidden" }, { value: "shown", label: "Shown" }]);
    expect(BATCH_OPTIONS).toEqual([
      { value: 0, label: "One message per spot" },
      { value: 10, label: "Group spots every 10 seconds" },
      { value: 30, label: "Group spots every 30 seconds" },
      { value: 60, label: "Group spots every 60 seconds" },
    ]);
  });

  it("resets the four field lists to fresh copies of the defaults", () => {
    const fields = defaultFields();
    expect(fields).toEqual({
      title_fields: DEFAULT_SETTINGS.title_fields, detail_fields: DEFAULT_SETTINGS.detail_fields,
      grid_fields: DEFAULT_SETTINGS.grid_fields, line_fields: DEFAULT_SETTINGS.line_fields,
    });
    expect(fields.title_fields).not.toBe(DEFAULT_SETTINGS.title_fields);
  });
});

const DEST: DiscordDestination = {
  id: "d1", name: "Spots channel", enabled: false, url_display: "discord.com/api/webhooks/123/••••",
  settings: { ...DEFAULT_SETTINGS, style: "plain", batch_seconds: 30 }, auto_disabled_at: null,
};

describe("the form", () => {
  it("starts blank with the defaults and the URL field open", () => {
    const form = blankForm();
    expect(form).toEqual({ name: "", enabled: true, url: "", settings: DEFAULT_SETTINGS });
    expect(form.settings).not.toBe(DEFAULT_SETTINGS);
    expect(form.settings.title_fields).not.toBe(DEFAULT_SETTINGS.title_fields);
  });

  it("loads a destination with the URL field closed", () => {
    const form = formOf(DEST);
    expect(form).toEqual({ id: "d1", name: "Spots channel", enabled: false, url: null, settings: DEST.settings });
    expect(form.settings.line_fields).not.toBe(DEST.settings.line_fields);
  });

  it("saves the RPC's shape: trimmed, no id when new, an empty URL kept as null", () => {
    expect(toInput({ ...blankForm(), name: " Spots ", url: " https://discord.com/api/webhooks/1/abc " })).toEqual({
      name: "Spots", enabled: true, url: "https://discord.com/api/webhooks/1/abc", settings: DEFAULT_SETTINGS,
    });
    expect(toInput(formOf(DEST))).toEqual({ id: "d1", name: "Spots channel", enabled: false, url: null, settings: DEST.settings });
    expect(toInput({ ...formOf(DEST), url: "   " }).url).toBeNull();
  });

  it("sends a saved destination's Enabled only when the switch changed from what was loaded", () => {
    const loaded = formOf(DEST);
    // A pause can land while the editor is open; Enabled on in the save would resume it.
    expect(toInput(loaded, loaded).enabled).toBeNull();
    expect(toInput({ ...loaded, name: "Spots 2" }, loaded).enabled).toBeNull();
    expect(toInput({ ...loaded, enabled: true }, loaded).enabled).toBe(true);
    const on = { ...loaded, enabled: true };
    expect(toInput({ ...on, enabled: false }, on).enabled).toBe(false);
    // A new destination always says what it starts as.
    const fresh = blankForm();
    expect(toInput(fresh, fresh).enabled).toBe(true);
    expect(toInput({ ...fresh, enabled: false }, fresh).enabled).toBe(false);
  });

  it("words the paused alert", () => {
    expect(discordPausedLine("3 hours ago")).toBe(
      "Paused 3 hours ago: Discord says this webhook no longer exists. Create a new webhook in Discord, select Replace URL, paste it, turn Enabled on and save.",
    );
  });

  it("is dirty when the saved input would change", () => {
    const form = formOf(DEST);
    expect(dirty(form, form)).toBe(false);
    expect(dirty(form, { ...form, name: "Spots channel " })).toBe(false);
    expect(dirty(form, { ...form, url: "" })).toBe(false);
    expect(dirty(form, { ...form, url: "https://discord.com/api/webhooks/1/abc" })).toBe(true);
    expect(dirty(form, { ...form, enabled: true })).toBe(true);
    expect(dirty(form, { ...form, settings: { ...form.settings, footer: false } })).toBe(true);
  });
});

describe("the card line", () => {
  it("names the style and the count", () => {
    expect(discordCardLine("card", 9)).toBe("Discord channel · Card · 9 fields");
    expect(discordCardLine("plain", 6)).toBe("Discord channel · Plain line · 6 fields");
    expect(discordCardLine("plain", 1)).toBe("Discord channel · Plain line · 1 field");
    expect(discordCardLine("odd" as "card", 2)).toBe("Discord channel · odd · 2 fields");
  });
});

describe("looksLikeWebhookUrl", () => {
  it("accepts both webhook hosts and refuses channel links and other URLs", () => {
    expect(looksLikeWebhookUrl("https://discord.com/api/webhooks/123/abc")).toBe(true);
    expect(looksLikeWebhookUrl(" https://discordapp.com/api/webhooks/123/abc ")).toBe(true);
    expect(looksLikeWebhookUrl("https://discord.com/channels/123/456")).toBe(false);
    expect(looksLikeWebhookUrl("https://discord.com/api/webhooks/")).toBe(false);
    expect(looksLikeWebhookUrl("http://discord.com/api/webhooks/123/abc")).toBe(false);
    expect(looksLikeWebhookUrl("")).toBe(false);
  });
});

describe("sendTestBlocker", () => {
  it("needs a saved destination with a URL and no unsaved changes", () => {
    expect(sendTestBlocker(undefined, false, false)).toBe("Add a webhook URL to send a test.");
    expect(sendTestBlocker(undefined, false, true)).toBe("Add a webhook URL to send a test.");
    // A new destination with a valid URL typed is blocked by the save, not the URL.
    expect(sendTestBlocker(undefined, true, true)).toBe("Save your changes to send a test.");
    expect(sendTestBlocker(undefined, true, false)).toBe("Save your changes to send a test.");
    expect(sendTestBlocker("d1", false, false)).toBe("Add a webhook URL to send a test.");
    expect(sendTestBlocker("d1", true, true)).toBe("Save your changes to send a test.");
    expect(sendTestBlocker("d1", true, false)).toBeNull();
  });
});
