import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { appValue, wrap } from "../test/render";
import { loadRecentSpots, type RecentSpot } from "../lib/api";
import { RecentSpotsCard } from "./RecentSpotsCard";
import { findLiveSource, type SourceInfo } from "./sources";

vi.mock("../lib/api", () => ({ loadRecentSpots: vi.fn() }));

const UTC = { utcTimes: true, timezone: "UTC" };
const spot = (source: string, callsign: string) => ({
  id: 1, source, callsign, frequency_khz: 14062, band: "20m", mode: "cw", pota_reference: null,
  sota_summit_ref: null, spotter: "K1ABC", spot_time: "2026-10-14T14:00:05Z",
}) as RecentSpot;

function source(id: string): SourceInfo {
  const found = findLiveSource(id);
  if (!found) throw new Error(`no source ${id}`);
  return found;
}

const card = (s: SourceInfo) => wrap(<MemoryRouter><RecentSpotsCard source={s} prefs={UTC} health={null} /></MemoryRouter>, appValue());

beforeEach(() => {
  vi.mocked(loadRecentSpots).mockReset();
});

describe("RecentSpotsCard", () => {
  it("ignores a response for a source it no longer shows", async () => {
    let resolvePota: (rows: RecentSpot[]) => void = () => undefined;
    vi.mocked(loadRecentSpots)
      .mockReturnValueOnce(new Promise((r) => (resolvePota = r)))
      .mockResolvedValueOnce([spot("rbn", "W2RBN")]);
    const { rerender } = render(card(source("pota")));
    rerender(card(source("rbn")));
    expect(await screen.findByText("W2RBN")).toBeInTheDocument();
    await act(async () => resolvePota([spot("pota", "W1POTA")]));
    expect(screen.queryByText("W1POTA")).not.toBeInTheDocument();
    expect(screen.getByText("W2RBN")).toBeInTheDocument();
    expect(loadRecentSpots).toHaveBeenNthCalledWith(1, "pota");
    expect(loadRecentSpots).toHaveBeenNthCalledWith(2, "rbn");
  });

  it("ignores a failure from a request a newer one replaced", async () => {
    let rejectOld: (err: Error) => void = () => undefined;
    vi.mocked(loadRecentSpots)
      .mockReturnValueOnce(new Promise((_r, reject) => (rejectOld = reject)))
      .mockResolvedValueOnce([spot("rbn", "W2RBN")]);
    const { rerender } = render(card(source("pota")));
    rerender(card(source("rbn")));
    expect(await screen.findByText("W2RBN")).toBeInTheDocument();
    await act(async () => rejectOld(new Error("late")));
    expect(screen.queryByText("late")).not.toBeInTheDocument();
  });
});
