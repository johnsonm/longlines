import { describe, expect, it } from "vitest";
import { csvSummary, groupMeta, limitText, mergeCallsigns, rejectedText, spotLines, wouldExceed } from "./model";
import type { GroupSpot } from "./types";

describe("groupMeta", () => {
  it("counts callsigns and subscriptions with singular forms", () => {
    expect(groupMeta(12, 1)).toBe("12 callsigns · used by 1 subscription");
    expect(groupMeta(1, 0)).toBe("1 callsign · used by 0 subscriptions");
    expect(groupMeta(1000, 2)).toBe("1,000 callsigns · used by 2 subscriptions");
  });
});

describe("spotLines", () => {
  const now = new Date("2026-10-13T14:02:30Z");
  const spot: GroupSpot = {
    callsign: "KK4PWJ", frequency_khz: 14062, band: "20m", mode: "CW", source: "pota", reference: "US-2763",
    spot_time: "2026-10-13T14:00:00Z",
  };

  it("reads like the mock", () => {
    expect(spotLines(spot, now)).toEqual(["KK4PWJ 14062.0 kHz CW", "20m · POTA · US-2763 · 2m ago"]);
  });

  it("leaves out what the spot doesn't have", () => {
    expect(spotLines({ ...spot, frequency_khz: null, band: null, mode: null, reference: null, source: "dxcluster" }, now))
      .toEqual(["KK4PWJ", "DX Cluster · 2m ago"]);
    expect(spotLines({ ...spot, mode: "ssb", spot_time: "2026-10-13T14:03:00Z" }, now)[0]).toBe("KK4PWJ 14062.0 kHz SSB");
    expect(spotLines({ ...spot, spot_time: "2026-10-13T14:03:00Z" }, now)[1]).toBe("20m · POTA · US-2763 · 0s ago");
  });
});

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
