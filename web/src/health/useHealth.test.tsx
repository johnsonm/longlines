import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { loadHealth } from "../lib/api";
import { healthPayload } from "../test/health";
import type { HealthPayload, HealthRange } from "./types";
import { REFRESH_MS, useHealth } from "./useHealth";

vi.mock("../lib/api", () => ({ loadHealth: vi.fn() }));

const payload = (generated_at: string, range: HealthRange = "24h") => healthPayload({ generated_at, range });
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(loadHealth).mockReset();
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("useHealth", () => {
  it("loads on mount, then every minute while visible", async () => {
    vi.mocked(loadHealth).mockResolvedValueOnce(payload("a")).mockResolvedValueOnce(payload("b"));
    const { result } = renderHook(() => useHealth("24h"));
    expect(result.current.loading).toBe(true);
    await settle();
    expect(result.current).toMatchObject({ payload: payload("a"), loading: false, error: null });
    expect(REFRESH_MS).toBe(60_000);
    hidden = true;
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    expect(loadHealth).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    expect(loadHealth).toHaveBeenCalledTimes(2);
    expect(result.current.payload).toEqual(payload("b"));
  });

  it("loads again at once on a range change and on refresh", async () => {
    vi.mocked(loadHealth).mockImplementation((range) => Promise.resolve(payload(range, range)));
    const { result, rerender } = renderHook(({ range }) => useHealth(range), { initialProps: { range: "24h" as HealthRange } });
    await settle();
    rerender({ range: "7d" });
    await settle();
    expect(vi.mocked(loadHealth).mock.calls).toEqual([["24h"], ["7d"]]);
    expect(result.current.payload?.range).toBe("7d");
    act(() => result.current.refresh());
    await settle();
    expect(vi.mocked(loadHealth).mock.calls).toEqual([["24h"], ["7d"], ["7d"]]);
  });

  it("drops a response for a range no longer shown", async () => {
    let resolveOld: (p: HealthPayload) => void = () => {};
    vi.mocked(loadHealth)
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(payload("new", "1h"));
    const { result, rerender } = renderHook(({ range }) => useHealth(range), { initialProps: { range: "24h" as HealthRange } });
    rerender({ range: "1h" });
    await settle();
    resolveOld(payload("old"));
    await settle();
    expect(result.current.payload?.generated_at).toBe("new");
  });

  it("keeps the last payload when a refresh fails, and ignores a failure for an old range", async () => {
    let rejectOld: (e: Error) => void = () => {};
    vi.mocked(loadHealth)
      .mockResolvedValueOnce(payload("a"))
      .mockRejectedValueOnce(new Error("Health is unavailable right now."))
      .mockReturnValueOnce(new Promise((_, r) => { rejectOld = r; }))
      .mockResolvedValueOnce(payload("b", "7d"));
    const { result, rerender } = renderHook(({ range }) => useHealth(range), { initialProps: { range: "24h" as HealthRange } });
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_MS));
    expect(result.current).toMatchObject({ payload: payload("a"), loading: false, error: "Health is unavailable right now." });
    // A third load for 24h is in flight when the range changes.
    act(() => result.current.refresh());
    rerender({ range: "7d" });
    await settle();
    rejectOld(new Error("late"));
    await settle();
    expect(result.current).toMatchObject({ payload: payload("b", "7d"), loading: false, error: null });
  });

  it("ignores a load that lands after unmount", async () => {
    let resolve: (p: HealthPayload) => void = () => {};
    vi.mocked(loadHealth).mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useHealth("24h"));
    unmount();
    resolve(payload("late"));
    await settle();
    expect(result.current.payload).toBeNull();
  });
});
