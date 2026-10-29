import { describe, expect, it } from "vitest";
import type { WebhookDestination, WebhookField, WebhookSettings } from "../lib/api";
import { sendTestBlocker as discordBlocker } from "./discordModel";
import {
  addHeader, answeredStatus, blankForm, createdSentence, extraHeaderLines, fixedHeaderLines, headerNeedsName, looksLikeHttpsUrl, requestPath, urlReplaced, DEFAULT_WEBHOOK_SETTINGS, defaultFields, dirty, FIELDS_MAX, FIELDS_MIN, formOf, FREQUENCY_UNITS, headerInput,
  headerNeedsValue, HEADERS_MAX, KEY_STYLES, missingHelper, MISSING_VALUES, PAUSE_AFTER, removeHeader, REQUEST_OPTIONS, requestsHelper,
  RETRY_POLICIES, sendTestBlocker, timeExample, TIME_FORMATS, toInput, updateHeader, WEBHOOK_FIELDS, webhookCardLine,
  webhookKey, type HeaderRow,
} from "./webhookModel";

// Read at transform time by Vite, so the node suite needs no fs access.
const MIGRATIONS: Record<string, string> = import.meta.glob("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The body of the newest definition of a SQL function (create or create or replace), up to its closing $$. */
function sqlFunction(name: string): string {
  const head = new RegExp(`create (or replace )?function public\\.${name}\\(`);
  const file = Object.keys(MIGRATIONS).sort().filter((f) => head.test(MIGRATIONS[f] ?? "")).at(-1);
  if (!file) throw new Error(`no migration defines ${name}`);
  const sql = MIGRATIONS[file] ?? "";
  const start = sql.search(head);
  return sql.slice(start, sql.indexOf("$$;", start));
}

/** webhook_default_settings()'s jsonb_build_object as a plain object. */
function sqlDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of sqlFunction("webhook_default_settings").matchAll(/'(\w+)', (jsonb_build_array\(([^)]*)\)|'([^']*)'|null|true|false|\d+)/g)) {
    const [, key, raw, array, text] = m;
    out[key!] = array !== undefined
      ? [...array.matchAll(/'([^']+)'/g)].map((x) => x[1])
      : text !== undefined ? text : raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  return out;
}

const SETTINGS: WebhookSettings = { ...DEFAULT_WEBHOOK_SETTINGS, fields: ["callsign", "frequency"], batch_seconds: 30 };

const DEST: WebhookDestination = {
  id: "w1", name: "Logger", enabled: true, url_display: "https://logger.example.org/hook/••••••", settings: SETTINGS,
  headers: [{ name: "Authorization" }, { name: "X-Key" }], secret_rotated_at: "2026-10-06T14:02:11Z", auto_disabled_at: null,
};

describe("the SQL pins", () => {
  it("has the same default settings as the newest webhook_default_settings(), pause 20 included", () => {
    expect(DEFAULT_WEBHOOK_SETTINGS).toEqual(sqlDefaults());
    expect(DEFAULT_WEBHOOK_SETTINGS.pause_after_failures).toBe(PAUSE_AFTER);
  });

  it("lists webhook_fields() in SQL's order", () => {
    const ids = [...sqlFunction("webhook_fields").matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(WEBHOOK_FIELDS.map((f) => f.id)).toEqual(ids);
  });

  it("keeps webhook_fields_valid()'s limits", () => {
    expect(sqlFunction("webhook_fields_valid")).toContain(`cardinality(p_fields) between ${FIELDS_MIN} and ${FIELDS_MAX}`);
  });
});

describe("the field list and options", () => {
  it("has the spec's fourteen labels plus the two names", () => {
    expect(WEBHOOK_FIELDS.map((f) => f.label)).toEqual([
      "Spot ID", "Time", "Callsign", "First name", "Last name", "Frequency", "Mode", "Band", "Source", "Reference", "Place name", "State", "Spotter", "Country",
      "Spot URL", "Comment (free text)",
    ]);
  });

  it("names every key as the spec's key table does", () => {
    const snake: Record<WebhookField, string> = {
      id: "id", time: "time", callsign: "callsign", first_name: "first_name", last_name: "last_name", frequency: "frequency_khz", mode: "mode", band: "band", source: "source",
      reference: "reference", place_name: "place_name", state: "state", spotter: "spotter", country: "country", url: "url", comment: "comment",
    };
    for (const f of WEBHOOK_FIELDS) {
      expect(webhookKey(f.id, "snake", "khz")).toBe(snake[f.id]);
      expect(webhookKey(f.id, "camel", "khz")).toBe({
        ...snake, first_name: "firstName", last_name: "lastName", frequency: "frequencyKhz", place_name: "placeName",
      }[f.id]);
    }
    expect(["khz", "mhz", "hz"].map((u) => webhookKey("frequency", "snake", u as WebhookSettings["frequency_unit"])))
      .toEqual(["frequency_khz", "frequency_mhz", "frequency_hz"]);
    expect(["khz", "mhz", "hz"].map((u) => webhookKey("frequency", "camel", u as WebhookSettings["frequency_unit"])))
      .toEqual(["frequencyKhz", "frequencyMhz", "frequencyHz"]);
  });

  it("offers the Copy's labels for every select", () => {
    expect(KEY_STYLES.map((o) => o.label)).toEqual(["snake_case", "camelCase"]);
    expect(TIME_FORMATS.map((o) => o.label)).toEqual(["ISO 8601, UTC", "Unix seconds"]);
    expect(FREQUENCY_UNITS.map((o) => o.label)).toEqual(["kHz", "MHz", "Hz"]);
    expect(MISSING_VALUES.map((o) => o.label)).toEqual(["Leave the key out", "Send null"]);
    expect(REQUEST_OPTIONS).toEqual([
      { value: 0, label: "One request per spot" },
      { value: 10, label: "Group spots every 10 seconds" },
      { value: 30, label: "Group spots every 30 seconds" },
      { value: 60, label: "Group spots every 60 seconds" },
    ]);
    expect(RETRY_POLICIES.map((o) => [o.value, o.label])).toEqual([
      ["none", "Don't retry"], ["three_10m", "Up to 3 times over 10 minutes"], ["day", "Keep trying for 24 hours"],
    ]);
  });

  it("gives helpers that follow the choice", () => {
    expect(timeExample("iso_utc")).toBe("2026-10-17T17:42:09Z");
    expect(timeExample("unix_seconds")).toBe("1792258929");
    expect(missingHelper("omit")).toBe("Or send null.");
    expect(missingHelper("null")).toBe("Or leave the key out.");
    expect(requestsHelper(0)).toBe(
      "Or group spots into one request every 10, 30 or 60 seconds. Grouped requests send a spots list instead of a single spot.",
    );
    expect(requestsHelper(30)).toBe("Or send one request per spot. Grouped requests send a spots list instead of a single spot.");
  });

  it("resets only to a copy of the default fields", () => {
    const fields = defaultFields();
    expect(fields).toEqual(DEFAULT_WEBHOOK_SETTINGS.fields);
    fields.push("comment");
    expect(DEFAULT_WEBHOOK_SETTINGS.fields).not.toContain("comment");
  });
});

describe("card line", () => {
  it("counts fields and names the window", () => {
    expect(webhookCardLine(11, 0)).toBe("Webhook · 11 fields");
    expect(webhookCardLine(1, 0)).toBe("Webhook · 1 field");
    expect(webhookCardLine(1, 30)).toBe("Webhook · 1 field · grouped every 30 seconds");
    expect(webhookCardLine(5, 10)).toBe("Webhook · 5 fields · grouped every 10 seconds");
  });
});

describe("header rows", () => {
  const row = (name: string, value: string, saved: string | null): HeaderRow => ({ key: name, name, value, saved });

  it("adds empty rows up to ten and removes and edits by key", () => {
    let rows: HeaderRow[] = [];
    for (let i = 0; i < HEADERS_MAX + 2; i++) rows = addHeader(rows);
    expect(rows).toHaveLength(HEADERS_MAX);
    expect(new Set(rows.map((r) => r.key)).size).toBe(HEADERS_MAX);
    expect(rows[0]).toMatchObject({ name: "", value: "", saved: null });
    const full = rows;
    expect(addHeader(full)).toBe(full);
    rows = updateHeader(rows, rows[1]!.key, { name: "X-Key", value: "k" });
    expect(rows[1]).toMatchObject({ name: "X-Key", value: "k" });
    rows = removeHeader(rows, rows[0]!.key);
    expect(rows).toHaveLength(HEADERS_MAX - 1);
    expect(rows[0]!.name).toBe("X-Key");
  });

  it("sends a saved row's value only when typed", () => {
    expect(headerInput(row("Authorization", "", "Authorization"))).toEqual({ name: "Authorization" });
    expect(headerInput(row(" Authorization ", "Bearer x", "Authorization"))).toEqual({ name: "Authorization", value: "Bearer x" });
  });

  it("asks for a value on a new or renamed row, not on a saved or case-only renamed one", () => {
    expect(headerNeedsValue(row("X-New", "", null), false)).toBe(true);
    expect(headerNeedsValue(row("X-New", "v", null), false)).toBe(false);
    expect(headerNeedsValue(row("", "", null), false)).toBe(false);
    expect(headerNeedsValue(row("X-Renamed", "", "X-Key"), false)).toBe(true);
    expect(headerNeedsValue(row("x-key", "", "X-Key"), false)).toBe(false);
    expect(headerNeedsValue(row("X-Key", "", "X-Key"), false)).toBe(false);
  });

  it("asks for every value while a new URL is typed, which clears the stored ones", () => {
    expect(headerNeedsValue(row("X-Key", "", "X-Key"), true)).toBe(true);
    expect(headerNeedsValue(row("X-Key", "v", "X-Key"), true)).toBe(false);
    expect(headerNeedsValue(row("", "", null), true)).toBe(false);
  });
});

describe("forms", () => {
  it("replaces the URL only on a saved destination with a URL typed", () => {
    const form = formOf(DEST);
    expect(urlReplaced(form)).toBe(false);
    expect(urlReplaced({ ...form, url: "  " })).toBe(false);
    expect(urlReplaced({ ...form, url: "https://new.example.org/hook" })).toBe(true);
    expect(urlReplaced({ ...blankForm(), url: "https://new.example.org/hook" })).toBe(false);
  });

  it("starts a new destination with the URL field open, the defaults and no headers", () => {
    const form = blankForm();
    expect(form).toEqual({ name: "", enabled: true, url: "", settings: DEFAULT_WEBHOOK_SETTINGS, headers: [] });
    form.settings.fields.push("comment");
    expect(DEFAULT_WEBHOOK_SETTINGS.fields).not.toContain("comment");
  });

  it("loads a saved destination with the URL closed and headers by name", () => {
    const form = formOf(DEST);
    expect(form).toMatchObject({ id: "w1", name: "Logger", enabled: true, url: null, settings: SETTINGS });
    expect(form.headers.map((h) => [h.name, h.value, h.saved])).toEqual([["Authorization", "", "Authorization"], ["X-Key", "", "X-Key"]]);
    form.settings.fields.push("comment");
    expect(SETTINGS.fields).not.toContain("comment");
  });

  it("trims, keeps the stored URL on an empty field and leaves blank new header rows out", () => {
    const form = { ...blankForm(), name: " Logger ", url: " https://logger.example.org/hook/abc " };
    form.headers = updateHeader(addHeader(addHeader([])), "x", {});
    form.headers = updateHeader(form.headers, form.headers[0]!.key, { name: "Authorization", value: "Bearer x" });
    expect(toInput(form)).toEqual({
      name: "Logger", enabled: true, url: "https://logger.example.org/hook/abc", settings: DEFAULT_WEBHOOK_SETTINGS,
      headers: [{ name: "Authorization", value: "Bearer x" }],
    });
    const saved = formOf(DEST);
    expect(toInput(saved)).toEqual({
      id: "w1", name: "Logger", enabled: true, url: null, settings: SETTINGS, headers: [{ name: "Authorization" }, { name: "X-Key" }],
    });
    expect(toInput({ ...saved, url: "  " }).url).toBeNull();
    // A saved row whose name was cleared is still sent, so SQL says "Give each header a name."
    expect(toInput({ ...saved, headers: updateHeader(saved.headers, saved.headers[0]!.key, { name: "" }) }).headers)
      .toEqual([{ name: "" }, { name: "X-Key" }]);
  });

  it("sends a saved destination's Enabled only when the switch changed from what was loaded", () => {
    const loaded = formOf(DEST);
    // A pause can land while the editor is open; Enabled on in the save would resume it (decision 4).
    expect(toInput(loaded, loaded).enabled).toBeNull();
    expect(toInput({ ...loaded, name: "Logger 2" }, loaded).enabled).toBeNull();
    expect(toInput({ ...loaded, enabled: false }, loaded).enabled).toBe(false);
    const paused = { ...loaded, enabled: false };
    expect(toInput({ ...paused, enabled: true }, paused).enabled).toBe(true);
    // A new destination always says what it starts as.
    const fresh = blankForm();
    expect(toInput(fresh, fresh).enabled).toBe(true);
    expect(toInput({ ...fresh, enabled: false }, fresh).enabled).toBe(false);
  });

  it("is dirty only when the save would change something", () => {
    const initial = formOf(DEST);
    expect(dirty(initial, formOf(DEST))).toBe(false);
    expect(dirty(initial, { ...initial, headers: addHeader(initial.headers) })).toBe(false);
    expect(dirty(initial, { ...initial, name: "Logger 2" })).toBe(true);
    expect(dirty(initial, { ...initial, enabled: false })).toBe(true);
    expect(dirty(initial, { ...initial, url: "https://x.example/h" })).toBe(true);
    expect(dirty(initial, { ...initial, settings: { ...initial.settings, pause_after_failures: null } })).toBe(true);
    expect(dirty(initial, { ...initial, headers: removeHeader(initial.headers, initial.headers[1]!.key) })).toBe(true);
    expect(dirty(initial, { ...initial, headers: updateHeader(initial.headers, initial.headers[0]!.key, { value: "new" }) })).toBe(true);
  });

  it("reads a receiver's status off a failed Send test, and nothing else", () => {
    expect(answeredStatus(Object.assign(new Error("Webhook HTTP 500"), { receiverStatus: 500 }))).toBe(500);
    expect(answeredStatus(Object.assign(new Error("x"), { receiverStatus: undefined }))).toBeNull();
    expect(answeredStatus(new Error("Webhook request failed: refused"))).toBeNull();
    expect(answeredStatus(null)).toBeNull();
    expect(answeredStatus("Webhook HTTP 500")).toBeNull();
  });

  it("shares Discord's Send test captions", () => {
    expect(sendTestBlocker).toBe(discordBlocker);
    expect(sendTestBlocker(undefined, false, false)).toBe("Add a webhook URL to send a test.");
    expect(sendTestBlocker(undefined, true, false)).toBe("Save your changes to send a test.");
    expect(sendTestBlocker("w1", true, true)).toBe("Save your changes to send a test.");
    expect(sendTestBlocker("w1", true, false)).toBeNull();
  });
});

describe("request preview helpers", () => {
  it("takes the typed URL's path, else the masked one's, without encoding the mask", () => {
    expect(requestPath("https://logger.example.org/hook/abc123?x=1#frag", null)).toBe("/hook/abc123?x=1");
    expect(requestPath(" https://logger.example.org ", null)).toBe("/");
    expect(requestPath("", "https://logger.example.org/hook/••••••")).toBe("/hook/••••••");
    expect(requestPath(null, "https://logger.example.org/hook/••••••")).toBe("/hook/••••••");
    expect(requestPath("logger.example.org", null)).toBe("/logger.example.org");
    expect(requestPath(null, null)).toBe("/");
    expect(requestPath("   ", null)).toBe("/");
  });

  it("lists the fixed five in the order sent, then each named extra header masked", () => {
    expect(fixedHeaderLines(1792258930)).toEqual([
      "Accept: */*",
      "Content-Type: application/json",
      "User-Agent: LongLines/0.2",
      "X-LongLines-Timestamp: 1792258930",
      "X-LongLines-Signature: sha256=…",
    ]);
    const rows: HeaderRow[] = [
      { key: "a", name: " Authorization ", value: "", saved: "Authorization" },
      { key: "b", name: "", value: "x", saved: null },
      { key: "c", name: "X-Key", value: "v", saved: null },
    ];
    expect(extraHeaderLines(rows)).toEqual(["Authorization: ••••••••", "X-Key: ••••••••"]);
  });

  it("asks for a name on a cleared saved row or a value typed alone", () => {
    expect(headerNeedsName({ key: "a", name: " ", value: "", saved: "X-Key" })).toBe(true);
    expect(headerNeedsName({ key: "b", name: "", value: "v", saved: null })).toBe(true);
    expect(headerNeedsName({ key: "c", name: "", value: "", saved: null })).toBe(false);
    expect(headerNeedsName({ key: "d", name: "X-Key", value: "", saved: "X-Key" })).toBe(false);
  });

  it("words the created dialog by the window", () => {
    expect(createdSentence("Logger", 0)).toBe("Logger will receive a request for each matching spot, with the fields you chose.");
    expect(createdSentence("Logger", 30)).toBe("Logger will receive a request every 30 seconds with the matching spots, with the fields you chose.");
  });
});

describe("URL check", () => {
  it("wants https and something after it", () => {
    expect(looksLikeHttpsUrl(" https://logger.example.org/hook ")).toBe(true);
    expect(looksLikeHttpsUrl("HTTPS://x")).toBe(true);
    expect(looksLikeHttpsUrl("http://logger.example.org")).toBe(false);
    expect(looksLikeHttpsUrl("https://")).toBe(false);
    expect(looksLikeHttpsUrl("https://a b")).toBe(false);
  });
});
