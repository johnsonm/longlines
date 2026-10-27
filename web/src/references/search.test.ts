import { describe, expect, it } from "vitest";
import {
  activationsLine, detailLine, matchesTitle, nameParts, noMatches, PROGRAM_CHIPS, searchWords, validSearch,
} from "./search";
import { MITCHELL_PARK, MITCHELL_SUMMIT, MITCHELL_WWFF, QUIET_SUMMIT, RETIRED_SUMMIT, TWO_STATE_PARK } from "./searchFixtures";

const NOW = new Date("2026-10-26T19:03:00Z");

describe("searchWords and validSearch", () => {
  it("splits the trimmed query on any whitespace", () => {
    expect(searchWords("  mount \t mitchell\n")).toEqual(["mount", "mitchell"]);
    expect(searchWords("   ")).toEqual([]);
  });

  it("takes 2 to 64 characters after trimming, in at most 6 words", () => {
    expect(validSearch("us")).toBe(true);
    expect(validSearch(" u ")).toBe(false);
    expect(validSearch("x".repeat(64))).toBe(true);
    expect(validSearch(` ${"x".repeat(64)} `)).toBe(true);
    expect(validSearch("x".repeat(65))).toBe(false);
    expect(validSearch("a b c d e f")).toBe(true);
    expect(validSearch("a b c d e f g")).toBe(false);
  });
});

describe("copy", () => {
  it("counts matches, singular and plural, with the query as typed", () => {
    expect(matchesTitle(7, "mitchell")).toBe('7 matches for "mitchell"');
    expect(matchesTitle(1, "US-2763")).toBe('1 match for "US-2763"');
  });

  it("says when nothing matched", () => {
    expect(noMatches("mitchel park nc")).toBe('No parks, summits or WWFF references match "mitchel park nc".');
  });

  it("lists the program chips in order, with phone labels", () => {
    expect(PROGRAM_CHIPS.map((c) => [c.program, c.label, c.short])).toEqual([
      [null, "All programs", "All"],
      ["pota", "POTA parks", "POTA"],
      ["sota", "SOTA summits", "SOTA"],
      ["wwff", "WWFF references", "WWFF"],
    ]);
  });
});

describe("nameParts", () => {
  it("marks every matched word, whatever its case", () => {
    expect(nameParts("Mount Mitchell State Park", ["MITCHELL", "park"])).toEqual([
      { text: "Mount ", match: false },
      { text: "Mitchell", match: true },
      { text: " State ", match: false },
      { text: "Park", match: true },
    ]);
  });

  it("marks a word inside a longer one, and every time it appears", () => {
    expect(nameParts("Lake Lakeview", ["lake"])).toEqual([
      { text: "Lake", match: true },
      { text: " ", match: false },
      { text: "Lake", match: true },
      { text: "view", match: false },
    ]);
  });

  it("prefers the longer word where two overlap", () => {
    expect(nameParts("Mitchell", ["mit", "mitchell"])).toEqual([{ text: "Mitchell", match: true }]);
  });

  it("treats regular expression characters and SQL wildcards as text", () => {
    expect(nameParts("100% (Wild) Area", ["%", "(wild)"])).toEqual([
      { text: "100", match: false },
      { text: "%", match: true },
      { text: " ", match: false },
      { text: "(Wild)", match: true },
      { text: " Area", match: false },
    ]);
    expect(nameParts("Mount_Mitchell", ["."])).toEqual([{ text: "Mount_Mitchell", match: false }]);
  });

  it("leaves a name alone when only the reference matched", () => {
    expect(nameParts("Mount Mitchell State Park", ["US-2763"])).toEqual([{ text: "Mount Mitchell State Park", match: false }]);
    expect(nameParts("Mount Mitchell", [])).toEqual([{ text: "Mount Mitchell", match: false }]);
    expect(nameParts("", ["x"])).toEqual([]);
  });
});

describe("detailLine", () => {
  it("shows a park's locations and grid", () => {
    expect(detailLine(MITCHELL_PARK)).toBe("US-NC · EM85");
    expect(detailLine(TWO_STATE_PARK)).toBe("US-NC, US-VA");
    expect(detailLine({ ...MITCHELL_PARK, location: null })).toBe("EM85");
  });

  it("shows a summit's association, region, altitude and points", () => {
    expect(detailLine(MITCHELL_SUMMIT)).toBe("W4C · NC-Central Mountains · 2,037 m · 10 points");
    expect(detailLine(QUIET_SUMMIT)).toBe("VK3 · 812 m · 1 point");
    expect(detailLine(RETIRED_SUMMIT)).toBe("W7O · OR-Coast Range North");
  });

  it("shows a WWFF reference's country and region", () => {
    expect(detailLine(MITCHELL_WWFF)).toBe("United States · North Carolina");
    expect(detailLine({ ...MITCHELL_WWFF, country: null })).toBe("North Carolina");
    expect(detailLine({ ...MITCHELL_WWFF, country: null, region: null })).toBe("");
  });
});

describe("activationsLine", () => {
  it("counts activations and the last day, this year without the year", () => {
    expect(activationsLine(MITCHELL_PARK, NOW)).toBe("148 activations · last Oct 26");
    expect(activationsLine({ activations: 1234, lastDay: "2026-07-04" }, NOW)).toBe("1,234 activations · last Jul 4");
    expect(activationsLine(TWO_STATE_PARK, NOW)).toBe("1 activation · last Jul 4, 2025");
  });

  it("says when a reference was never activated", () => {
    expect(activationsLine(QUIET_SUMMIT, NOW)).toBe("No activations yet");
  });

  it("leaves the day out if SQL has none", () => {
    expect(activationsLine({ activations: 3, lastDay: null }, NOW)).toBe("3 activations");
  });
});
