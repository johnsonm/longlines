import { describe, expect, it } from "vitest";
import { NOW, bands, card, parks, progress, states } from "../test/goals";
import { BANDS } from "../sources/sources";
import {
  US_STATES, addEntries, allStates, atLeastHint, dateWarning, defaultEntries, draftOf, inputOf, knownSince, markingHelp,
  markingWarning, newRequirement, nextKind, parkNames, parkReference, removeEntry, withCompleteWhen, withKind, yearWindow,
  type GoalDraft,
} from "./editModel";
import type { GoalEntry, GoalProgress } from "./types";

// Migration sources, read at transform time by Vite, as states.test.ts reads them.
const MIGRATIONS: Record<string, string> = import.meta.glob("../../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The array a migration's newest `create function public.<name>()` returns. */
function sqlArray(name: string): string[] {
  const file = Object.keys(MIGRATIONS).sort().filter((f) => MIGRATIONS[f]?.includes(`function public.${name}()`)).at(-1);
  if (!file) throw new Error(`no migration defines ${name}()`);
  const src = MIGRATIONS[file] ?? "";
  const body = src.slice(src.indexOf(`function public.${name}()`));
  const arr = /select array\[([^\]]*)\]/.exec(body);
  if (!arr?.[1]) throw new Error(`${file}: ${name}() array not found`);
  return [...arr[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

const contact = (e: GoalEntry, at: string): GoalEntry => ({
  ...e, worked_at: at, worked_how: "contact",
  evidence: { worked_call: "K4ABC", contact_time: at, logger_app: "N1MM", matched_spot_time: null },
});

/** The canvas's edge frame: GA, SC and Cape Lookout worked by contact in January and February. */
function earlyContacts(): GoalProgress {
  const st = states();
  st.entries = st.entries.map((e) =>
    e.value === "GA" ? contact(e, "2026-01-14T15:00:00Z") : e.value === "SC" ? contact(e, "2026-02-02T18:30:00Z") : e
  );
  const pk = parks();
  pk.entries[1] = contact(pk.entries[1]!, "2026-02-20T13:00:00Z");
  pk.entries[0] = contact(pk.entries[0]!, "2026-10-03T21:14:00Z");
  return progress({ requirements: [st, pk, bands()] });
}

describe("US_STATES", () => {
  it("is us_states() in its order", () => {
    expect(US_STATES).toEqual(sqlArray("us_states"));
    expect(US_STATES).toHaveLength(50);
  });

  it("offers only bands goal_bands() takes", () => {
    const sql = sqlArray("goal_bands");
    expect(BANDS.filter((b) => !sql.includes(b))).toEqual([]);
  });
});

describe("draftOf", () => {
  it("starts a new list this year, from the relay, with all 50 states", () => {
    const d = draftOf(null, NOW);
    expect(d).toMatchObject({ id: null, name: "", window: "dates", startsOn: "2026-01-01", endsOn: "2026-12-31", marking: "relay" });
    expect(d.requirements).toHaveLength(1);
    expect(d.requirements[0]).toMatchObject({ id: null, kind: "state", completeWhen: "all", atLeast: "" });
    expect(d.requirements[0]!.entries).toEqual(US_STATES);
  });

  it("loads a list's window, marking and requirements in position order", () => {
    const p = progress({ requirements: [bands({ position: 3 }), states({ position: 1 }), parks({ position: 2 })] });
    const d = draftOf(p, NOW);
    expect(d).toMatchObject({ id: "n1", name: "2026 chase", window: "dates", startsOn: "2026-01-01", endsOn: "2026-12-31" });
    expect(d.requirements.map((r) => r.kind)).toEqual(["state", "park", "band"]);
    expect(d.requirements[2]).toMatchObject({ id: "r-bands", key: "r-bands", completeWhen: "at_least", atLeast: "4" });
    expect(d.requirements[2]!.entries).toEqual(["80m", "40m", "20m", "15m", "10m", "6m"]);
  });

  it("keeps this year's dates ready for a list with no end date", () => {
    const d = draftOf(progress({ list: card({ starts_on: null, ends_on: null }) }), NOW);
    expect(d).toMatchObject({ window: "open", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  });

  it("knows the loaded parks' names", () => {
    expect(parkNames(progress())["US-2763"]).toBe("Hanging Rock State Park");
    expect(parkNames(null)).toEqual({});
  });
});

describe("inputOf", () => {
  it("sends the list whole, ids where SQL has them", () => {
    const d = draftOf(progress(), NOW);
    d.name = "  2026 chase ";
    const input = inputOf(d);
    expect(input).toMatchObject({ id: "n1", name: "2026 chase", starts_on: "2026-01-01", ends_on: "2026-12-31", marking: "relay" });
    expect(input.requirements[2]).toEqual({
      id: "r-bands", kind: "band", complete_when: "at_least", at_least: 4, entries: ["80m", "40m", "20m", "15m", "10m", "6m"],
    });
    expect(input.requirements[0]).toMatchObject({ complete_when: "all", at_least: null });
  });

  it("leaves ids out of a new list and its new requirements", () => {
    const input = inputOf(draftOf(null, NOW));
    expect("id" in input).toBe(false);
    expect("id" in input.requirements[0]!).toBe(false);
  });

  it("sends no dates for no end date, and an empty date or How many as null for SQL to explain", () => {
    const d: GoalDraft = { ...draftOf(null, NOW), window: "open" };
    expect(inputOf(d)).toMatchObject({ starts_on: null, ends_on: null });
    expect(inputOf({ ...d, window: "dates", startsOn: "" })).toMatchObject({ starts_on: null, ends_on: "2026-12-31" });
    const r = { ...newRequirement("band", "k"), completeWhen: "at_least" as const, atLeast: "four" };
    expect(inputOf({ ...d, requirements: [r] }).requirements[0]!.at_least).toBeNull();
  });
});

describe("requirements", () => {
  it("starts each kind with its default entries", () => {
    expect(defaultEntries("state")).toEqual(US_STATES);
    expect(defaultEntries("band")).toEqual(["80m", "40m", "20m", "15m", "10m", "6m"]);
    expect(defaultEntries("park")).toEqual([]);
  });

  it("adds the first kind the list lacks", () => {
    expect(nextKind([])).toBe("state");
    expect(nextKind([{ kind: "state" }])).toBe("park");
    expect(nextKind([{ kind: "state" }, { kind: "park" }])).toBe("band");
    expect(nextKind([{ kind: "state" }, { kind: "park" }, { kind: "band" }])).toBe("state");
  });

  it("makes a requirement anew when its kind changes", () => {
    const r = { ...newRequirement("state", "k"), id: "r1", completeWhen: "at_least" as const, atLeast: "10" };
    expect(withKind(r, "state")).toBe(r);
    expect(withKind(r, "band")).toEqual({ key: "k", id: null, kind: "band", completeWhen: "all", atLeast: "", entries: defaultEntries("band") });
  });

  it("starts At least one short of the entries, and keeps a number typed", () => {
    const r = newRequirement("band", "k");
    expect(withCompleteWhen(r, "at_least").atLeast).toBe("5");
    expect(withCompleteWhen({ ...r, entries: [] }, "at_least").atLeast).toBe("1");
    expect(withCompleteWhen({ ...r, atLeast: "3" }, "at_least").atLeast).toBe("3");
    expect(withCompleteWhen({ ...r, atLeast: "3" }, "all")).toMatchObject({ completeWhen: "all", atLeast: "3" });
  });

  it("adds entries once, states and bands in their lists' order", () => {
    expect(addEntries("state", ["NC", "AK"], ["AL", "NC"])).toEqual(["AL", "AK", "NC"]);
    expect(addEntries("band", ["20m"], ["160m", "20m"])).toEqual(["160m", "20m"]);
    expect(addEntries("band", ["2200m"], ["20m"])).toEqual(["20m", "2200m"]);
    expect(addEntries("park", ["US-0002"], ["US-0001", "US-0002"])).toEqual(["US-0002", "US-0001"]);
    expect(removeEntry(["A", "B"], "A")).toEqual(["B"]);
  });

  it("knows every state at once", () => {
    expect(allStates([...US_STATES])).toBe(true);
    expect(allStates(US_STATES.slice(1))).toBe(false);
  });

  it("takes a typed POTA reference in any case", () => {
    expect(parkReference(" us-2763 ")).toBe("US-2763");
    expect(parkReference("K-0001")).toBe("K-0001");
    expect(parkReference("Mount Mitchell")).toBeNull();
    expect(parkReference("US-27")).toBeNull();
  });

  it("explains At least while How many is a number", () => {
    expect(atLeastHint({ completeWhen: "at_least", atLeast: "4" })).toBe("Once you've worked 4 of these, the rest stop alerting.");
    expect(atLeastHint({ completeWhen: "at_least", atLeast: "" })).toBeNull();
    expect(atLeastHint({ completeWhen: "all", atLeast: "4" })).toBeNull();
  });
});

describe("markingHelp", () => {
  it("says the relay is connected only when it is", () => {
    expect(markingHelp("relay", { status: "recent" })).toBe(
      'The relay is connected. Choose "By hand only" if you don\'t log with N1MM or WSJT-X. Spots never mark an entry on their own.',
    );
    expect(markingHelp("relay", { status: "stale" })).toBe(
      'Choose "By hand only" if you don\'t log with N1MM or WSJT-X. Spots never mark an entry on their own.',
    );
    expect(markingHelp("relay", null)).not.toContain("connected");
    expect(markingHelp("hand", { status: "recent" })).toBe("Spots never mark an entry on their own.");
  });
});

describe("dateWarning", () => {
  const moved = (p: GoalProgress, over: Partial<GoalDraft>): GoalDraft => ({ ...draftOf(p, NOW), ...over });

  it("names the contact marks before the new start date, as the canvas does", () => {
    const p = earlyContacts();
    expect(dateWarning(p, moved(p, { startsOn: "2026-03-01" }))).toEqual({
      title: "3 worked entries fall before the new start date",
      text:
        "GA, SC and Cape Lookout National Seashore were worked in January and February. When you save, they go back to needed and your connections start alerting for them again.",
    });
  });

  it("says nothing while every contact mark stays inside the dates", () => {
    const p = earlyContacts();
    expect(dateWarning(p, draftOf(p, NOW))).toBeNull();
    expect(dateWarning(p, moved(p, { window: "open" }))).toBeNull();
    expect(dateWarning(p, moved(p, { startsOn: "" }))).toBeNull();
    expect(dateWarning(null, draftOf(null, NOW))).toBeNull();
  });

  it("never counts hand marks", () => {
    // Blue Ridge Parkway, twelve states and three bands were marked by hand on Oct 20 and 21; two parks by contact.
    const p = progress();
    expect(dateWarning(p, moved(p, { startsOn: "2026-10-25" }))?.title).toBe("2 worked entries fall before the new start date");
  });

  it("words one entry, entries after the end, and both sides", () => {
    const p = earlyContacts();
    expect(dateWarning(p, moved(p, { startsOn: "2026-02-01" }))).toEqual({
      title: "1 worked entry falls before the new start date",
      text: "GA was worked in January. When you save, it goes back to needed and your connections start alerting for it again.",
    });
    expect(dateWarning(p, moved(p, { endsOn: "2026-09-30" }))?.title).toBe("1 worked entry falls after the new end date");
    expect(dateWarning(p, moved(p, { startsOn: "2026-02-01", endsOn: "2026-09-30" }))?.title).toBe("2 worked entries fall outside the new dates");
  });

  it("leaves out entries and requirements the draft removes or changes", () => {
    const p = earlyContacts();
    const d = moved(p, { startsOn: "2026-03-01" });
    d.requirements[0] = { ...d.requirements[0]!, entries: removeEntry(d.requirements[0]!.entries, "GA") };
    d.requirements[1] = withKind(d.requirements[1]!, "band");
    expect(dateWarning(p, d)?.text).toBe("SC was worked in February. When you save, it goes back to needed and your connections start alerting for it again.");
  });

  it("is quiet for a list marked by hand only", () => {
    const p = earlyContacts();
    expect(dateWarning(p, moved(p, { startsOn: "2026-03-01", marking: "hand" }))).toBeNull();
  });

  it("names five entries, then how many more, with years across a new year", () => {
    const st = states();
    const codes = ["AK", "AZ", "AR", "CA", "CO", "CT", "DE"];
    st.entries = st.entries.map((e) => {
      const i = codes.indexOf(e.value);
      return i < 0 ? e : contact(e, i === 0 ? "2025-12-30T12:00:00Z" : "2026-01-05T12:00:00Z");
    });
    const p = progress({ list: card({ starts_on: "2025-12-01" }), requirements: [st] });
    expect(dateWarning(p, moved(p, { startsOn: "2026-02-01" }))?.text).toBe(
      "AK, AZ, AR, CA, CO and 2 more were worked in December 2025 and January 2026. When you save, they go back to needed and your connections start alerting for them again.",
    );
  });
});

describe("markingWarning", () => {
  it("warns when a relay list turns to By hand only and has contact marks", () => {
    const p = progress();
    const d = { ...draftOf(p, NOW), marking: "hand" as const };
    expect(markingWarning(p, d)).toEqual({
      title: "2 worked entries came from your log",
      text:
        "Great Smoky Mountains National Park and Cape Lookout National Seashore were marked from contacts you logged. When you save, they go back to needed and your connections start alerting for them again. Mark them worked by hand from the progress page.",
    });
  });

  it("is quiet otherwise", () => {
    const p = progress();
    expect(markingWarning(p, draftOf(p, NOW))).toBeNull();
    expect(markingWarning(null, { ...draftOf(null, NOW), marking: "hand" })).toBeNull();
    const handList = progress({ list: card({ marking: "hand" }) });
    expect(markingWarning(handList, { ...draftOf(handList, NOW), marking: "hand" })).toBeNull();
    const none = progress({ requirements: [states()] });
    expect(markingWarning(none, { ...draftOf(none, NOW), marking: "hand" })).toBeNull();
  });

  it("words one entry", () => {
    const pk = parks();
    pk.entries[1] = { ...pk.entries[1]!, worked_at: null, worked_how: null, evidence: null };
    const p = progress({ requirements: [pk] });
    expect(markingWarning(p, { ...draftOf(p, NOW), marking: "hand" })?.text).toBe(
      "Great Smoky Mountains National Park was marked from contacts you logged. When you save, it goes back to needed and your connections start alerting for it again. Mark it worked by hand from the progress page.",
    );
  });
});

describe("knownSince", () => {
  it("shows while the window starts before the first contact", () => {
    const p = progress();
    expect(knownSince(p, draftOf(p, NOW))).toEqual({
      title: "Long Lines only knows contacts since Oct 16, 2026",
      text: "That's when you connected the relay. Anything you worked before then isn't counted. Mark those entries worked by hand from the progress page.",
    });
    expect(knownSince(p, { ...draftOf(p, NOW), window: "open" })?.title).toBe("Long Lines only knows contacts since Oct 16, 2026");
  });

  it("is quiet once the window starts on or after it, by hand, or with no contact yet", () => {
    const p = progress();
    expect(knownSince(p, { ...draftOf(p, NOW), startsOn: "2026-10-16" })).toBeNull();
    expect(knownSince(p, { ...draftOf(p, NOW), startsOn: "" })).toBeNull();
    expect(knownSince(p, { ...draftOf(p, NOW), marking: "hand" })).toBeNull();
    expect(knownSince(progress({ first_contact_at: null }), draftOf(p, NOW))).toBeNull();
    expect(knownSince(null, draftOf(null, NOW))).toBeNull();
  });
});

describe("yearWindow", () => {
  it("is the UTC year", () => {
    expect(yearWindow(new Date("2026-12-31T23:30:00-05:00"))).toEqual({ startsOn: "2027-01-01", endsOn: "2027-12-31" });
  });
});
