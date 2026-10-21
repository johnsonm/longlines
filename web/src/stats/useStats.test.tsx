import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { LatestStats } from "./types";

vi.mock("../lib/api", () => ({ loadLatestStats: vi.fn() }));

// The snapshot cache lives at module scope; load a fresh copy for each test.
async function fresh() {
  vi.resetModules();
  const api = await import("../lib/api");
  const { useStats } = await import("./useStats");
  return { load: vi.mocked(api.loadLatestStats), useStats };
}

const stats = (generatedAt: string) => ({ payload: { totals: { spots: 1 } }, generatedAt }) as unknown as LatestStats;

beforeEach(() => {
  vi.useRealTimers();
});

describe("useStats", () => {
  it("loads once and serves later mounts from the cache while fresh", async () => {
    const { load, useStats } = await fresh();
    const value = stats(new Date().toISOString());
    load.mockResolvedValue(value);
    const first = renderHook(() => useStats());
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.stats).toBe(value);

    const second = renderHook(() => useStats());
    expect(second.result.current).toEqual({ stats: value, loading: false, error: null });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not keep a missing snapshot", async () => {
    const { load, useStats } = await fresh();
    load.mockResolvedValue(null);
    const first = renderHook(() => useStats());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.stats).toBeNull();
    renderHook(() => useStats());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("reports load errors", async () => {
    const { load, useStats } = await fresh();
    load.mockRejectedValue(new Error("Couldn't load stats."));
    const { result } = renderHook(() => useStats());
    await waitFor(() => expect(result.current.error).toBe("Couldn't load stats."));
    expect(result.current.loading).toBe(false);
  });

  it("ignores a result that arrives after unmount", async () => {
    const { load, useStats } = await fresh();
    let resolve: (v: LatestStats | null) => void = () => {};
    load.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useStats());
    unmount();
    resolve(stats(new Date().toISOString()));
    await Promise.resolve();
    expect(result.current.stats).toBeNull();
  });

  it("ignores an error that arrives after unmount", async () => {
    const { load, useStats } = await fresh();
    let reject: (e: Error) => void = () => {};
    load.mockReturnValue(new Promise((_r, j) => (reject = j)));
    const { result, unmount } = renderHook(() => useStats());
    unmount();
    reject(new Error("late"));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.error).toBeNull();
  });
});

describe("freshUntil", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");

  it("keeps a snapshot until an hour after the server wrote it", async () => {
    const { freshUntil } = await import("./useStats");
    expect(freshUntil("2026-10-19T11:20:00Z", now)).toBe(now + 20 * 60_000);
  });

  it("keeps a snapshot at least a minute after it arrives, however fast the browser clock is", async () => {
    const { freshUntil } = await import("./useStats");
    expect(freshUntil("2026-10-19T09:00:00Z", now)).toBe(now + 60_000);
    expect(freshUntil("not a time", now)).toBe(now + 60_000);
  });

  it("keeps a snapshot at most an hour after it arrives, however slow the browser clock is", async () => {
    const { freshUntil } = await import("./useStats");
    expect(freshUntil("2026-10-19T15:00:00Z", now)).toBe(now + 60 * 60_000);
  });
});

describe("useStats with a skewed clock", () => {
  const server = "2026-10-19T12:00:00Z";

  async function mountAndSettle(useStats: () => unknown) {
    const { result } = renderHook(() => useStats() as { loading: boolean });
    await waitFor(() => expect(result.current.loading).toBe(false));
  }

  it("asks once a minute at most when the browser clock is two hours fast", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.parse(server) + 2 * 60 * 60_000);
    const { load, useStats } = await fresh();
    load.mockResolvedValue(stats(server));
    await mountAndSettle(useStats);
    await mountAndSettle(useStats);
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await mountAndSettle(useStats);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("asks again within an hour when the browser clock is three hours slow", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(Date.parse(server) - 3 * 60 * 60_000);
    const { load, useStats } = await fresh();
    load.mockResolvedValue(stats(server));
    await mountAndSettle(useStats);
    vi.setSystemTime(Date.now() + 59 * 60_000);
    await mountAndSettle(useStats);
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await mountAndSettle(useStats);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
