import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { loadBandMap } from "../lib/api";
import type { BandMapPayload } from "./types";
import { REFRESH_MS, useBandMap } from "./useBandMap";

vi.mock("../lib/api", () => ({ loadBandMap: vi.fn() }));

const payload = (generated_at: string): BandMapPayload => ({ bands: [], generated_at });
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(loadBandMap).mockReset();
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Lets the resolved load's then/finally run.
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("useBandMap", () => {
  it("loads on mount, then every 30 seconds", async () => {
    vi.mocked(loadBandMap).mockResolvedValueOnce(payload("a")).mockResolvedValueOnce(payload("b"));
    const { result } = renderHook(() => useBandMap());
    expect(result.current.loading).toBe(true);
    await settle();
    expect(result.current).toEqual({ payload: payload("a"), loading: false, error: null });
    expect(REFRESH_MS).toBe(30_000);
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    expect(loadBandMap).toHaveBeenCalledTimes(2);
    expect(result.current.payload).toEqual(payload("b"));
  });

  it("pauses while the tab is hidden and loads again when it comes back", async () => {
    vi.mocked(loadBandMap).mockResolvedValue(payload("a"));
    renderHook(() => useBandMap());
    await settle();
    hidden = true;
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS * 3));
    expect(loadBandMap).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(loadBandMap).toHaveBeenCalledTimes(2);
  });

  it("keeps the last payload when a refresh fails, and clears the error when one succeeds", async () => {
    vi.mocked(loadBandMap)
      .mockResolvedValueOnce(payload("a"))
      .mockRejectedValueOnce(new Error("The band map is unavailable right now."))
      .mockResolvedValueOnce(payload("c"));
    const { result } = renderHook(() => useBandMap());
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    expect(result.current).toEqual({ payload: payload("a"), loading: false, error: "The band map is unavailable right now." });
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    expect(result.current).toEqual({ payload: payload("c"), loading: false, error: null });
  });

  it("ignores a load that lands after unmount", async () => {
    let resolve: (p: BandMapPayload) => void = () => {};
    vi.mocked(loadBandMap).mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useBandMap());
    unmount();
    resolve(payload("late"));
    await settle();
    expect(result.current.payload).toBeNull();
  });
});
