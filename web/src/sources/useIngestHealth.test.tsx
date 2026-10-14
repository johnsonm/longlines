import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { loadIngestHealth, type IngestHealth } from "../lib/api";
import { useIngestHealth } from "./useIngestHealth";

vi.mock("../lib/api", () => ({ loadIngestHealth: vi.fn() }));

const rows = [{ source: "pota", seconds_since_last_success: 5 }] as IngestHealth[];

beforeEach(() => {
  vi.mocked(loadIngestHealth).mockReset().mockResolvedValue(rows);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useIngestHealth", () => {
  it("loads once without polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useIngestHealth(null));
    await waitFor(() => expect(result.current.health).toEqual(rows));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(loadIngestHealth).toHaveBeenCalledTimes(1);
  });

  it("polls while mounted and stops on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = renderHook(() => useIngestHealth(30_000));
    await waitFor(() => expect(loadIngestHealth).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(loadIngestHealth).toHaveBeenCalledTimes(2);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(loadIngestHealth).toHaveBeenCalledTimes(2);
  });

  it("reports a failure and leaves health unknown", async () => {
    vi.mocked(loadIngestHealth).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useIngestHealth(null));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.health).toBeNull();
  });
});
