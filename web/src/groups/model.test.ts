import { describe, expect, it } from "vitest";
import { csvSummary, limitText, mergeCallsigns, rejectedText, wouldExceed } from "./model";

describe("mergeCallsigns", () => {
  it("adds new calls, drops repeats and sorts", () => {
    expect(mergeCallsigns(["N4DXX", "KK4PWJ"], ["AB4RD", "KK4PWJ"])).toEqual(["AB4RD", "KK4PWJ", "N4DXX"]);
    expect(mergeCallsigns([], [])).toEqual([]);
  });
});

describe("limits", () => {
  it("refuses more than 1,000", () => {
    expect(wouldExceed(1000)).toBe(false);
    expect(wouldExceed(1001)).toBe(true);
    expect(limitText(1240)).toBe("That would make 1,240 callsigns. A group can hold up to 1,000.");
  });
});

describe("rejectedText", () => {
  it("lists what wasn't added", () => {
    expect(rejectedText(["N0PE", "12345", "QRZ?"])).toBe("Not callsigns, so not added: N0PE, 12345, QRZ?");
  });

  it("stops at 20", () => {
    const values = Array.from({ length: 23 }, (_, i) => `X${i}`);
    expect(rejectedText(values)).toBe(`Not callsigns, so not added: ${values.slice(0, 20).join(", ")} and 3 more`);
  });

  it("is null when nothing was rejected", () => {
    expect(rejectedText([])).toBeNull();
  });
});

describe("csvSummary", () => {
  it("names the column it used", () => {
    expect(csvSummary("roster.csv", "Callsign", 42, 3)).toBe("roster.csv: using the Callsign column. Found 42 callsigns, skipped 3.");
    expect(csvSummary("roster.csv", null, 1, 0)).toBe("roster.csv: using the first column. Found 1 callsign, skipped 0.");
  });
});
