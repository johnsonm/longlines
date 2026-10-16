import { describe, expect, it } from "vitest";
import type { IngestHealth } from "../lib/api";
import { findLiveSource, type SourceInfo } from "./sources";
import { sourceStatus, STATUS_LABEL } from "./status";

const health = (source: string, age: number | null) => ({ source, seconds_since_last_success: age }) as IngestHealth;
const pota = findLiveSource("pota")!; // pollSeconds 60

/** A made-up planned source: the catalog has none right now, but the planned paths stay. */
const planned: SourceInfo = { ...findLiveSource("rbn")!, id: "future", title: "Future source", mark: "FS", status: "planned", statsKey: null };

describe("sourceStatus", () => {
  it("is connected within three poll intervals", () => {
    expect(sourceStatus(pota, [health("pota", 180)])).toBe("connected");
  });
  it("is delayed past three poll intervals", () => {
    expect(sourceStatus(pota, [health("pota", 181)])).toBe("delayed");
  });
  it("is delayed with no health row or no success yet", () => {
    expect(sourceStatus(pota, [])).toBe("delayed");
    expect(sourceStatus(pota, [health("pota", null)])).toBe("delayed");
  });
  it("falls back to connected when health is unknown", () => {
    expect(sourceStatus(pota, null)).toBe("connected");
  });
  it("is planned for a planned source whatever the health", () => {
    expect(sourceStatus(planned, [])).toBe("planned");
  });
  it("labels each status", () => {
    expect(STATUS_LABEL).toEqual({ connected: "Connected", delayed: "Delayed", planned: "Not yet available" });
  });
});
