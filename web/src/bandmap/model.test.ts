import { describe, expect, it } from "vitest";
import { BAND_PLAN, type BandPlan } from "../lib/bandplan";
import {
  bandStations, CROWD_DIVISOR, crowdAround, crowdDetail, crowdTitle, crowdTolerance, heardLabel, laneFor, mhz,
  segmentMarks, sourceInfo, spotAge, tooltipText, updatedLabel,
} from "./model";
import type { BandMapPayload, BandMapSource, BandMapSpot } from "./types";

const NOW = new Date("2026-10-14T13:45:00Z");
const plan = (band: string): BandPlan => BAND_PLAN.find((p) => p.band === band)!;
const ALL: ReadonlySet<BandMapSource> = new Set(["dxcluster", "pota", "sotawatch"]);

let nextId = 1;
function spot(over: Partial<BandMapSpot> = {}): BandMapSpot {
  return {
    id: nextId++,
    callsign: "KK4PWJ",
    base_callsign: "KK4PWJ",
    frequency_khz: 14062,
    mode: "cw",
    source: "pota",
    spot_time: "2026-10-14T13:43:00Z",
    spotter: "W1AW",
    reference: "US-0817",
    reference_name: "Pisgah National Forest",
    ...over,
  };
}
const payload = (band: string, spots: BandMapSpot[]): BandMapPayload => ({
  bands: [{ band, spots }],
  generated_at: "2026-10-14T13:44:30Z",
});

describe("lanes", () => {
  it("puts DX Cluster at the bottom, POTA in the middle and SOTA on top", () => {
    expect(laneFor("dxcluster")).toBe(0);
    expect(laneFor("pota")).toBe(1);
    expect(laneFor("sotawatch")).toBe(2);
  });

  it("gives each source its app-wide color and label", () => {
    expect(sourceInfo("dxcluster")).toMatchObject({ label: "DX Cluster", color: "success" });
    expect(sourceInfo("pota")).toMatchObject({ label: "POTA", color: "primary" });
    expect(sourceInfo("sotawatch")).toMatchObject({ label: "SOTA", color: "secondary" });
  });
});

describe("bandStations", () => {
  it("keeps one row per base call per band, the latest winning, when the payload holds duplicates", () => {
    const early = spot({ callsign: "KK4PWJ", spot_time: "2026-10-14T13:41:00Z", frequency_khz: 14062 });
    const late = spot({ callsign: "KK4PWJ/P", source: "dxcluster", spot_time: "2026-10-14T13:44:00Z", frequency_khz: 14064 });
    const other = spot({ callsign: "W1AW", base_callsign: "W1AW", frequency_khz: 14010 });
    expect(bandStations(payload("20m", [early, late, other]), plan("20m"), ALL)).toEqual([other, late]);
  });

  it("reads only its own band", () => {
    expect(bandStations(payload("40m", [spot({ frequency_khz: 7030 })]), plan("20m"), ALL)).toEqual([]);
    expect(bandStations(null, plan("20m"), ALL)).toEqual([]);
  });

  it("leaves off spots outside the plan's range, keeping the edges", () => {
    const low = spot({ base_callsign: "A1", frequency_khz: 28000 });
    const high = spot({ base_callsign: "A2", frequency_khz: 28600 });
    const above = spot({ base_callsign: "A3", frequency_khz: 29600 });
    expect(bandStations(payload("10m", [low, high, above]), plan("10m"), ALL)).toEqual([low, high]);
  });

  it("shows only the sources switched on", () => {
    const pota = spot({ base_callsign: "A1", source: "pota" });
    const dx = spot({ base_callsign: "A2", source: "dxcluster" });
    expect(bandStations(payload("20m", [pota, dx]), plan("20m"), new Set<BandMapSource>(["dxcluster"]))).toEqual([dx]);
  });
});

describe("crowds", () => {
  it("nets width / 140 on desktop and width / 45 on a phone", () => {
    expect(CROWD_DIVISOR).toEqual({ mobile: 45, desktop: 140 });
    expect(crowdTolerance(plan("20m"), false)).toBeCloseTo(350 / 140);
    expect(crowdTolerance(plan("20m"), true)).toBeCloseTo(350 / 45);
    expect(crowdTolerance(plan("30m"), false)).toBeCloseTo(50 / 140);
  });

  const ft8 = [14072, 14074, 14074.5, 14075, 14076.4, 14077].map((f, i) => spot({ base_callsign: `S${i}`, callsign: `S${i}`, frequency_khz: f }));

  it("gathers everyone within the tolerance, the clicked station included, low to high", () => {
    const tol = crowdTolerance(plan("20m"), false); // 2.5 kHz
    expect(crowdAround(ft8, ft8[3]!, tol).map((s) => s.frequency_khz)).toEqual([14074, 14074.5, 14075, 14076.4, 14077]);
  });

  it("is just the station when nobody is near", () => {
    const alone = spot({ base_callsign: "Z", frequency_khz: 14200 });
    expect(crowdAround([...ft8, alone], alone, crowdTolerance(plan("20m"), false))).toEqual([alone]);
  });

  it("works at the band edges, where the net only reaches inward", () => {
    const edge = [1800, 1801, 1802, 1806].map((f, i) => spot({ base_callsign: `E${i}`, frequency_khz: f }));
    const tol = crowdTolerance(plan("160m"), false); // 200 / 140 ≈ 1.43 kHz
    expect(crowdAround(edge, edge[0]!, tol).map((s) => s.frequency_khz)).toEqual([1800, 1801]);
    const top = [2000, 1999.5, 1995].map((f, i) => spot({ base_callsign: `T${i}`, frequency_khz: f }));
    expect(crowdAround(top, top[0]!, tol).map((s) => s.frequency_khz)).toEqual([1999.5, 2000]);
    // A phone's wider net (200 / 45 ≈ 4.4 kHz) takes in more from the edge.
    expect(crowdAround(edge, edge[0]!, crowdTolerance(plan("160m"), true))).toHaveLength(3);
  });
});

describe("segmentMarks", () => {
  it("hides 160m's Phone label, three kilohertz after Digital, but keeps its line", () => {
    expect(segmentMarks(plan("160m"))).toEqual([
      { x: 1800, label: "CW", line: false },
      { x: 1840, label: "Digital", line: true },
      { x: 1843, label: undefined, line: true },
    ]);
  });

  it("hides 80m's Phone label too, 6% of the band after Digital", () => {
    expect(segmentMarks(plan("80m")).map((m) => m.label)).toEqual(["CW", "Digital", undefined]);
  });

  it("shows all three on 20m", () => {
    expect(segmentMarks(plan("20m"))).toEqual([
      { x: 14000, label: "CW", line: false },
      { x: 14070, label: "Digital", line: true },
      { x: 14150, label: "Phone", line: true },
    ]);
  });

  it("never draws the first segment's line, which sits on the band edge", () => {
    for (const p of BAND_PLAN) {
      const marks = segmentMarks(p);
      expect(marks[0]).toMatchObject({ x: p.from, line: false });
      expect(marks[0]!.label).toBeDefined();
    }
  });
});

describe("text", () => {
  const ft8 = spot({ callsign: "EA7HAM", frequency_khz: 14075, mode: "ft8", source: "dxcluster", reference: null, spot_time: "2026-10-14T13:43:00Z" });

  it("formats MHz ticks", () => {
    expect(mhz(14050)).toBe("14.050");
    expect(mhz(1800)).toBe("1.800");
  });

  it("ages a spot in whole minutes, now under one", () => {
    expect(spotAge("2026-10-14T13:44:30Z", NOW)).toBe("now");
    expect(spotAge("2026-10-14T13:43:00Z", NOW)).toBe("2m ago");
  });

  it("builds the tooltip", () => {
    expect(tooltipText(spot({ frequency_khz: 14062 }), NOW)).toBe("KK4PWJ  14062.0 kHz CW · 2m ago");
    expect(tooltipText(spot({ mode: null }), NOW)).toBe("KK4PWJ  14062.0 kHz · 2m ago");
  });

  it("builds a crowd row, with the reference when there is one", () => {
    expect(crowdDetail(ft8, NOW)).toBe("14075.0 kHz FT8 · DX Cluster · 2m ago");
    expect(crowdDetail(spot(), NOW)).toBe("14062.0 kHz CW · POTA US-0817 · 2m ago");
    expect(crowdDetail(spot({ source: "sotawatch", reference: "W4C/CM-001" }), NOW)).toBe("14062.0 kHz CW · SOTA W4C/CM-001 · 2m ago");
  });

  it("titles a crowd and a band", () => {
    expect(crowdTitle(26, 14082)).toBe("26 stations near 14.082");
    expect(heardLabel("20m", 71)).toBe("20m · 71 heard");
  });

  it("says when the snapshot was made", () => {
    expect(updatedLabel("2026-10-14T13:44:30Z", NOW)).toBe("Updated 30 seconds ago");
    expect(updatedLabel("2026-10-14T13:44:59Z", NOW)).toBe("Updated 1 second ago");
    expect(updatedLabel("2026-10-14T13:45:05Z", NOW)).toBe("Updated 0 seconds ago");
    expect(updatedLabel("2026-10-14T13:43:30Z", NOW)).toBe("Updated 1 minute ago");
    expect(updatedLabel("2026-10-14T13:40:00Z", NOW)).toBe("Updated 5 minutes ago");
  });
});
