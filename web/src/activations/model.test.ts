import { describe, expect, it } from "vitest";
import { CONTINUED, COUNTRIES, IOTA, LIST, SINGLE, SPLIT, TWOFER, WWBOTA } from "./fixtures";
import {
  aboutKm, bandsModesLabel, cardNames, cardNote, chips, continuedNote, continuedOn, dateLine, dayHeading, dayNote, documentTitle, duration,
  emptyMessage, estimateNote, farthestLabel, groupByDay, heardIn, heardSentence, khzLabel, modeLabel, modesLabel, mostActivatedDetail,
  namesLabel, nextDay, onAirLabel, overline, pageHeading, phoneDetail, phoneWindow, previousDay, referencesCaption, shortDay, sourceLabel,
  sourcesPresent, spotPhoneDetail, spotPlace, spotsLine, timeOnAirRow, timeWindow, utcTime,
} from "./model";
import type { ActivationCard, ActivationPlace } from "./types";

const card = (over: Partial<ActivationCard>): ActivationCard => ({ ...LIST.recent[0]!, ...over });

describe("days and times", () => {
  it("words a UTC day as the canvas does", () => {
    expect(dayHeading("2026-10-29")).toBe("Thu 29 Oct 2026");
    // The canvas's sample weekdays don't match 2026's calendar; these are the real ones.
    expect(dayHeading("2026-10-25")).toBe("Sun 25 Oct 2026");
    expect(shortDay("2026-10-13")).toBe("Tue 13 Oct");
  });

  it("steps days across month and year ends", () => {
    expect(previousDay("2026-11-01")).toBe("2026-10-31");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
    expect(nextDay("2026-10-31")).toBe("2026-11-01");
  });

  it("reads clock times from the ISO string, never the local zone", () => {
    expect(utcTime("2026-10-29T23:58:00Z")).toBe("23:58");
    expect(timeWindow({ startedAt: "2026-10-29T18:12:00Z", lastSpotAt: "2026-10-29T19:40:00Z" })).toBe("18:12–19:40");
    expect(timeWindow({ startedAt: "2026-10-28T16:20:00Z", lastSpotAt: "2026-10-28T16:20:30Z" })).toBe("16:20");
  });

  it("words a duration in hours and minutes", () => {
    expect(duration(5280)).toBe("1 h 28 min");
    expect(duration(2820)).toBe("47 min");
    expect(duration(7200)).toBe("2 h");
    expect(duration(20)).toBe("1 min");
    expect(duration(0)).toBeNull();
  });

  it("words time on air in whole hours, minutes under one", () => {
    expect(onAirLabel(111600)).toBe("31 h");
    expect(onAirLabel(16260)).toBe("5 h");
    expect(onAirLabel(2820)).toBe("47 min");
    expect(onAirLabel(0)).toBe("0 h");
  });
});

describe("references and names", () => {
  it("joins references and the names the feed gave", () => {
    expect(pageHeading(TWOFER)).toBe("KK4PWJ at US-1182 · US-1871");
    expect(documentTitle(TWOFER)).toBe("KK4PWJ at US-1182 · US-1871 · Spotted activation");
    expect(namesLabel(TWOFER.referenceNames)).toBe("Juniper Ridge Wildlife Management Area · Willow Hollow Wildlife Management Area");
    // WWBOTA names only the first bunker.
    expect(namesLabel(WWBOTA.referenceNames)).toBe("Seed ROC Post");
  });

  it("says the program on a list row for anything but POTA", () => {
    expect(cardNames(card({ program: "pota", referenceNames: ["Eno River State Park"] }))).toBe("Eno River State Park");
    expect(cardNames(card({ program: "sota", referenceNames: ["Mount Mitchell"] }))).toBe("Mount Mitchell · SOTA");
    expect(cardNames(card({ program: "wwbota", referenceNames: [null, null] }))).toBe("WWBOTA");
  });

  it("words the overline per program", () => {
    expect(overline("pota")).toBe("Spotted activation · POTA");
    expect(overline("iota")).toBe("Spotted activation · IOTA");
  });
});

describe("bands, modes and sources", () => {
  it("folds USB and LSB into SSB, once each", () => {
    expect(modeLabel("usb")).toBe("SSB");
    expect(modeLabel("ft8")).toBe("FT8");
    expect(modesLabel(["usb", "lsb", "cw"])).toBe("SSB · CW");
    expect(bandsModesLabel(["20m", "40m"], ["ssb", "cw"])).toBe("20m · 40m · SSB · CW");
    expect(bandsModesLabel([], [])).toBe("");
  });

  it("names sources as the page does, and lists them in its order", () => {
    expect(sourceLabel("dxcluster")).toBe("DX cluster");
    expect(sourceLabel("sotawatch")).toBe("SOTAwatch");
    expect(sourceLabel("other")).toBe("other");
    expect(sourcesPresent(TWOFER.spots)).toEqual(["pota", "rbn", "dxcluster"]);
    expect(sourcesPresent([{ source: "zzz" }, { source: "rbn" }, { source: "aaa" }])).toEqual(["rbn", "aaa", "zzz"]);
  });

  it("words the Spots row from SQL's counts", () => {
    expect(spotsLine(TWOFER.spotCount, TWOFER.sources)).toBe("11 · POTA 7 · RBN 3 · DX cluster 1");
    expect(spotsLine(31, { pota: 8, rbn: 19, dxcluster: 4 })).toBe("31 · POTA 8 · RBN 19 · DX cluster 4");
  });

  it("groups kHz", () => {
    expect(khzLabel(14285)).toBe("14,285");
    expect(khzLabel(14239.1)).toBe("14,239.1");
  });
});

describe("where it was heard", () => {
  it("counts states and countries", () => {
    expect(heardIn(14, 2)).toBe("14 states · 2 countries");
    expect(heardIn(14, 2, ", ")).toBe("14 states, 2 countries");
    expect(heardIn(1, 1)).toBe("1 state · 1 country");
    expect(heardIn(6, 0)).toBe("6 states");
    expect(heardIn(0, 3)).toBe("3 countries");
    expect(heardIn(0, 0)).toBeNull();
  });

  it("words the map's caption", () => {
    const place = (kind: "state" | "country", name: string): ActivationPlace => ({ kind, code: name, name, latitude: 0, longitude: 0, spots: 1 });
    const states = Array.from({ length: 14 }, (_, i) => place("state", `S${i}`));
    expect(heardSentence([...states, place("country", "Canada"), place("country", "Germany")])).toBe("Heard in 14 states, plus Canada and Germany.");
    expect(heardSentence(TWOFER.heard)).toBe("Heard in 5 states, plus Fed. Rep. of Germany and Canada.");
    expect(heardSentence(SINGLE.heard)).toBe("Heard in 1 state.");
    expect(heardSentence(COUNTRIES.heard)).toBe("Heard in Canada and Japan.");
    expect(heardSentence([place("country", "Japan")])).toBe("Heard in Japan.");
    expect(heardSentence(["A", "B", "C", "D", "E"].map((n) => place("country", n)))).toBe("Heard in A, B, C and 2 more countries.");
    expect(heardSentence([place("state", "X"), ...["A", "B", "C", "D"].map((n) => place("country", n))]))
      .toBe("Heard in 1 state, plus A, B, C and 1 more country.");
    expect(heardSentence([{ ...place("country", "x"), name: null, code: "VE" }])).toBe("Heard in VE.");
    expect(heardSentence(IOTA.heard)).toBe("No spotter's place is known yet.");
  });

  it("rounds the farthest distance to two significant figures", () => {
    expect(aboutKm(6995)).toBe("about 7,000 km");
    expect(aboutKm(1074)).toBe("about 1,100 km");
    expect(aboutKm(56)).toBe("about 56 km");
    expect(aboutKm(4.4)).toBe("about 4 km");
    expect(farthestLabel(TWOFER.farthest!)).toBe("Fed. Rep. of Germany · about 7,000 km");
    expect(farthestLabel({ kind: "country", code: "DL", name: null, km: 7000 })).toBe("DL · about 7,000 km");
  });
});

describe("chips and notes", () => {
  it("chips a two-fer, a single spot and a midnight split", () => {
    expect(chips({ ...TWOFER, ...TWOFER.split })).toEqual(["Two-fer"]);
    expect(chips({ ...SINGLE, ...SINGLE.split })).toEqual(["1 spot"]);
    expect(chips({ ...SPLIT, ...SPLIT.split })).toEqual(["Split at 00:00 UTC"]);
    expect(chips({ ...CONTINUED, ...CONTINUED.split })).toEqual(["Split at 00:00 UTC"]);
    expect(chips({ ...WWBOTA, ...WWBOTA.split })).toEqual(["Two-fer"]);
  });

  it("notes a single spot, and the later half of a split by the day before", () => {
    expect(cardNote(card({ spotCount: 1 }))).toBe("Only spotted once. It may have ended early or just not been re-spotted.");
    expect(cardNote(card({ continuedFrom: "x", day: "2026-10-14" })))
      .toBe("Continued from Tue 13 Oct. POTA counts each UTC day as its own activation.");
    expect(continuedNote("2026-10-14")).toBe("Continued from Tue 13 Oct. POTA counts each UTC day as its own activation.");
    expect(continuedOn("2026-10-13")).toBe("Continued on Wed 14 Oct.");
    expect(cardNote(card({}))).toBeNull();
  });

  it("notes a busy day by its program's word", () => {
    expect(dayNote([{ program: "pota" }, { program: "pota" }, { program: "pota" }])).toBe("3 parks in one day");
    expect(dayNote([{ program: "sota" }, { program: "sota" }])).toBe("2 summits in one day");
    expect(dayNote([{ program: "wwff" }, { program: "wwff" }])).toBe("2 references in one day");
    expect(dayNote([{ program: "pota" }, { program: "sota" }])).toBe("2 activations in one day");
    expect(dayNote([{ program: "pota" }])).toBeNull();
  });
});

describe("the list", () => {
  it("groups SQL's newest-first list by day, each day in the order it happened", () => {
    const days = groupByDay(LIST.recent);
    expect(days.map((d) => d.day)).toEqual(["2026-10-31", "2026-10-30", "2026-10-29", "2026-10-28", "2026-10-26"]);
    expect(days[3]!.cards.map((c) => timeWindow(c))).toEqual(["14:00–14:40", "15:30–16:10", "17:20"]);
    expect(dayNote(days[3]!.cards)).toBe("3 parks in one day");
  });

  it("words a phone row", () => {
    const [last, split, , single, , rover, twofer] = LIST.recent;
    expect(phoneWindow(twofer!)).toBe("18:12–19:40 · 1 h 28 min");
    expect(phoneDetail(twofer!)).toBe("20m · 40m · SSB · CW · 11 spots · 5 states, 2 countries");
    expect(phoneWindow(single!)).toBe("17:20");
    expect(phoneDetail(single!)).toBe("20m · CW · Only spotted once. It may have ended early or just not been re-spotted.");
    expect(phoneDetail(split!)).toBe("40m · 80m · SSB · 3 spots · 3 states. Continued from Thu 29 Oct.");
    expect(phoneDetail(rover!)).toBe("20m · 40m · CW · SSB · 6 spots · 3 states, 1 country");
    expect(phoneDetail(card({ ...last, states: 0, countries: 0 }))).toBe("20m · 30m · CW · 3 spots");
  });

  it("words the cards", () => {
    expect(referencesCaption(LIST.summary.references)).toBe("5 parks");
    expect(referencesCaption({ total: 18, pota: 14, sota: 4, wwff: 0, wwbota: 0, iota: 0 })).toBe("14 parks · 4 summits");
    expect(referencesCaption({ total: 5, pota: 1, sota: 1, wwff: 1, wwbota: 1, iota: 1 }))
      .toBe("1 park · 1 summit · 1 WWFF reference · 1 bunker · 1 island");
    expect(referencesCaption({ total: 6, pota: 0, sota: 0, wwff: 2, wwbota: 2, iota: 2 })).toBe("2 WWFF references · 2 bunkers · 2 islands");
    const most = LIST.summary.mostActivated!;
    expect(mostActivatedDetail(most, false)).toBe("Juniper Ridge Wildlife Management Area · 3 times");
    expect(mostActivatedDetail(most, true)).toBe("3 times");
    expect(mostActivatedDetail({ ...most, name: null, times: 1 }, false)).toBe("1 time");
    expect(emptyMessage("W1AW")).toBe("Long Lines hasn't spotted an activation by W1AW yet.");
  });
});

describe("the page", () => {
  it("words the date line and Time on air", () => {
    expect(dateLine(TWOFER)).toBe("Mon 26 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min");
    expect(dateLine(SINGLE)).toBe("Wed 28 Oct 2026 · 17:20 UTC");
    expect(timeOnAirRow(TWOFER)).toBe("1 h 28 min · 18:12–19:40 UTC");
    expect(timeOnAirRow(SINGLE)).toBe("17:20 UTC");
  });

  it("words a spot's place and phone line", () => {
    const [self, chased, , dx] = TWOFER.spots;
    expect(spotPlace(self!)).toBe("self-spot");
    expect(spotPlace(chased!)).toBe("North Carolina");
    expect(spotPhoneDetail(self!)).toBe("14,239.1 kHz · SSB · US-1182");
    expect(spotPhoneDetail(chased!)).toBe("North Carolina · 14,273.1 kHz · SSB · US-1871");
    expect(spotPhoneDetail(dx!)).toBe("New York · 14,285 kHz · SSB");
    expect(spotPhoneDetail({ ...dx!, place: null, frequencyKhz: null, mode: null })).toBe("");
  });

  it("explains the estimate with the gap and the program", () => {
    expect(estimateNote(TWOFER)).toBe(
      "Long Lines grouped KK4PWJ's spots at these references with no gap longer than 45 minutes, then added RBN and DX cluster spots "
        + "from the same window. Contacts aren't counted, so this can't confirm the activation met POTA's minimum.",
    );
    expect(estimateNote(COUNTRIES)).toContain("K0AAAS's spots at this reference");
    expect(estimateNote(COUNTRIES)).toContain("met WWFF's minimum.");
  });
});
