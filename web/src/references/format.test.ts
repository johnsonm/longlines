import { describe, expect, it } from "vitest";
import { NOT_IN_LIST, PARK, RETIRED, SUMMIT, WWFF_REF } from "./fixtures";
import {
  aboutRows, aboutSubheader, aboutTitle, activationDetail, cellActivators, coordinates, footerText, gridLabel, headerChips, isRetired, isToday,
  modesLabel, neverActivatedMessage, notFoundMessage, notInListMessage, periodLabel, periodTitle, phoneSpotTime, retiredMessage, selfSpot,
  shortDay, spotDetail, spotTime, todayLine, topActivatorDetail,
} from "./format";

const NOW = new Date("2026-10-26T19:03:00Z");
const labels = (profile: Parameters<typeof headerChips>[0]) => headerChips(profile).map((c) => (c.outlined ? `(${c.label})` : c.label));

describe("header chips", () => {
  it("follows each program's order", () => {
    expect(labels(PARK)).toEqual(["US-NC", "EM85", "Active"]);
    expect(labels(SUMMIT)).toEqual(["W4C · NC-Central Mountains", "2,037 m", "10 points", "EM85"]);
    expect(labels(WWFF_REF)).toEqual(["United States", "K-NC", "EM85"]);
  });

  it("starts a retired reference with an outlined Retired chip and drops Active", () => {
    expect(labels(RETIRED)).toEqual(["(Retired)", "W4C · NC-Eastern Mountains", "1,412 m", "1 point", "EM96"]);
    expect(labels({ ...PARK, catalog: { ...PARK.catalog!, active: false } })).toEqual(["(Retired)", "US-NC", "EM85"]);
  });

  it("shows only the outlined not-in-the-list chip outside the list, and leaves out what the list doesn't give", () => {
    expect(labels(NOT_IN_LIST)).toEqual(["(Not in the POTA list)"]);
    expect(labels({ ...PARK, catalog: { ...PARK.catalog!, location: "US-NC,US-VA", grid: null } })).toEqual(["US-NC, US-VA", "Active"]);
    const bare = { ...SUMMIT.catalog!, association: null, altitudeM: null, points: null, grid: null };
    expect(labels({ ...SUMMIT, catalog: bare })).toEqual(["NC-Central Mountains"]);
    expect(labels({ ...SUMMIT, catalog: { ...bare, region: null } })).toEqual([]);
  });
});

describe("About card", () => {
  it("lists each program's rows in order", () => {
    expect(aboutRows("pota", PARK.catalog!)).toEqual([
      ["Name", "Mount Mitchell State Park"], ["Program", "Parks on the Air"], ["Location", "US-NC"], ["Grid", "EM85"],
      ["Coordinates", "35.7650, -82.2652"], ["Status", "Active"],
    ]);
    expect(aboutRows("sota", SUMMIT.catalog!).map(([l]) => l)).toEqual(
      ["Name", "Program", "Region", "Altitude", "Points", "Grid", "Coordinates", "Status"],
    );
    expect(aboutRows("wwff", WWFF_REF.catalog!)).toContainEqual(["Program", "World Wide Flora and Fauna"]);
    expect(aboutRows("wwff", WWFF_REF.catalog!).map(([l]) => l)).toEqual(["Name", "Program", "Region", "Country", "Grid", "Coordinates", "Status"]);
  });

  it("says when a retired reference was valid until", () => {
    const rows = aboutRows("sota", RETIRED.catalog!);
    expect(rows).toContainEqual(["Status", "Retired"]);
    expect(rows.at(-1)).toEqual(["Valid until", "Dec 31, 2019"]);
    expect(aboutRows("sota", { ...RETIRED.catalog!, validTo: null }).at(-1)).toEqual(["Status", "Retired"]);
  });

  it("titles the card per program", () => {
    expect(aboutTitle("pota")).toBe("About this park");
    expect(aboutTitle("wwff")).toBe("About this reference");
    expect(aboutSubheader("pota")).toBe("From the POTA park list. Refreshed weekly.");
    expect(aboutSubheader("sota")).toBe("From the SOTA summit list. Refreshed weekly.");
    expect(aboutSubheader("wwff")).toBe("From the WWFF directory. Refreshed weekly.");
    expect(coordinates(35.765, -82.2652)).toBe("35.7650, -82.2652");
  });
});

describe("states", () => {
  it("words a retired reference with and without its date", () => {
    expect(retiredMessage("sota", RETIRED.catalog!)).toBe(
      "This summit was retired from the SOTA list on Dec 31, 2019. Activations of it no longer count for SOTA.",
    );
    expect(retiredMessage("pota", { ...PARK.catalog!, active: false })).toBe(
      "This park is retired in the POTA list. Activations of it no longer count for POTA.",
    );
    expect(isRetired(RETIRED.catalog)).toBe(true);
    expect(isRetired(PARK.catalog)).toBe(false);
    expect(isRetired(null)).toBe(false);
  });

  it("words a reference outside the list, one never activated, and one not found", () => {
    expect(notInListMessage("pota", "US-12940")).toBe(
      "US-12940 isn't in the POTA park list. Long Lines shows it because activators were spotted here. It may be a new park, or a typo in the spots.",
    );
    expect(notInListMessage("wwff", "KFF-9999")).toMatch(/^KFF-9999 isn't in the WWFF directory\. .* It may be a new reference, or a typo/);
    expect(neverActivatedMessage("US-4471")).toBe("Long Lines hasn't heard an activation at US-4471 yet.");
    expect(notFoundMessage("pota", "US-27X3")).toBe("Long Lines has no POTA park US-27X3. Check the reference, like US-2763 or W4C/CM-001.");
    expect(notFoundMessage("iota", "EU-005")).toBe("Long Lines has no reference EU-005.");
  });

  it("closes the page with the program's note", () => {
    expect(footerText(PARK)).toBe(
      "An activation here means an activator was spotted at US-2763 on that UTC day. Long Lines sees spots, not logs, so these counts aren't POTA's own. "
        + "Park details come from the POTA park list.",
    );
    expect(footerText(WWFF_REF)).toMatch(/aren't WWFF's own\. Reference details come from the WWFF directory\.$/);
    expect(footerText(NOT_IN_LIST)).toMatch(/so these counts aren't POTA's own\.$/);
  });
});

describe("times and rows", () => {
  it("counts today's spots in words", () => {
    expect(todayLine({ spots: 18, bands: ["20m", "40m"] })).toBe("Spotted 18 times today, on 20m and 40m.");
    expect(todayLine({ spots: 1, bands: ["20m"] })).toBe("Spotted once today, on 20m.");
    expect(todayLine({ spots: 1200, bands: [] })).toBe("Spotted 1,200 times today.");
    expect(isToday("2026-10-26T00:10:00Z", NOW)).toBe(true);
    expect(isToday("2026-10-25T23:59:00Z", NOW)).toBe(false);
  });

  it("shortens days and times for the tables and phone rows", () => {
    expect(shortDay("2026-10-25", NOW)).toBe("Oct 25");
    expect(shortDay("2025-10-25", NOW)).toBe("Oct 25, 2025");
    expect(spotTime("2026-10-26T18:51:00Z")).toBe("Oct 26 18:51");
    expect(phoneSpotTime("2026-10-26T18:51:00Z", NOW)).toBe("18:51");
    expect(phoneSpotTime("2026-10-25T21:04:00Z", NOW)).toBe("Oct 25");
    expect(topActivatorDetail(22, "2026-10-26", NOW)).toBe("22 · Oct 26");
  });

  it("describes a spot and an activation for phone rows", () => {
    const [first, self, plain] = PARK.recentSpots;
    expect(spotDetail(first!)).toBe("14062.0 kHz · CW · by KX4FBS");
    expect(spotDetail(self!)).toBe("7035.5 kHz · CW · self-spot");
    expect(selfSpot(self!)).toBe(true);
    expect(selfSpot(plain!)).toBe(false);
    expect(spotDetail({ ...plain!, frequencyKhz: null, mode: null })).toBe("by W3PLS");
    expect(activationDetail(PARK.recentActivations[0]!)).toBe("20m, 40m · CW · 18 spots");
    expect(activationDetail(PARK.recentActivations[1]!)).toBe("40m · USB, SSB · 1 spot");
    expect(activationDetail({ ...PARK.recentActivations[1]!, bands: [], modes: [] })).toBe("1 spot");
    expect(modesLabel(["cw", "CW", "ft8"])).toBe("CW, FT8");
  });

  it("words the heat map's periods and days", () => {
    expect(periodLabel({ period: "past" })).toBe("Past 365 days");
    expect(periodLabel({ period: "2025" })).toBe("2025");
    expect(periodTitle({ period: "past" })).toBe("Activations in the past year");
    expect(periodTitle({ period: "2025" })).toBe("Activations in 2025");
    expect(gridLabel({ period: "past" })).toBe("Heat map of activations per day for the past 365 days. A table view has the same numbers.");
    expect(gridLabel({ period: "2025" })).toBe("Heat map of activations per day in 2025. A table view has the same numbers.");
    expect(cellActivators(0)).toBe("No activations");
    expect(cellActivators(1)).toBe("1 activator");
    expect(cellActivators(5)).toBe("5 activators");
  });
});
