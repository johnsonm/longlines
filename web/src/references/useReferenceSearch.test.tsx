import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { searchReferences } from "../lib/api";
import { EMPTY, MITCHELL } from "./searchFixtures";
import type { ReferenceProgram } from "./types";
import { useReferenceSearch } from "./useReferenceSearch";

vi.mock("../lib/api", () => ({ searchReferences: vi.fn() }));

// The cache is module state shared by every test here, so each test uses its own queries.

beforeEach(() => {
  vi.mocked(searchReferences).mockReset();
});

describe("useReferenceSearch", () => {
  it("asks nothing without a query", () => {
    const { result } = renderHook(() => useReferenceSearch(null, "pota"));
    expect(result.current).toEqual({ search: null, error: null, loading: false });
    expect(searchReferences).not.toHaveBeenCalled();
  });

  it("searches once and serves the same search from the cache next time", async () => {
    vi.mocked(searchReferences).mockResolvedValue(MITCHELL);
    const first = renderHook(() => useReferenceSearch("mitchell", null));
    expect(first.result.current).toEqual({ search: null, error: null, loading: true });
    await waitFor(() => expect(first.result.current.search).toBe(MITCHELL));
    expect(searchReferences).toHaveBeenCalledWith("mitchell", null);
    first.unmount();

    const again = renderHook(() => useReferenceSearch("mitchell", null));
    expect(again.result.current).toEqual({ search: MITCHELL, error: null, loading: false });
    expect(searchReferences).toHaveBeenCalledTimes(1);
  });

  it("keeps each program's search apart, a query with spaces included", async () => {
    vi.mocked(searchReferences).mockResolvedValueOnce(MITCHELL).mockResolvedValueOnce(EMPTY);
    const { result, rerender } = renderHook(({ program }: { program: ReferenceProgram | null }) => useReferenceSearch("mount mitchell", program), {
      initialProps: { program: null as ReferenceProgram | null },
    });
    await waitFor(() => expect(result.current.search).toBe(MITCHELL));
    rerender({ program: "wwff" });
    // The other program's result is stale: loading, not the old rows.
    expect(result.current).toEqual({ search: null, error: null, loading: true });
    await waitFor(() => expect(result.current.search).toBe(EMPTY));
    expect(searchReferences).toHaveBeenLastCalledWith("mount mitchell", "wwff");
  });

  it("reports a failure and tries again next time", async () => {
    const failure = new Error("Too many lookups. Try again in a minute.");
    vi.mocked(searchReferences).mockRejectedValueOnce(failure).mockResolvedValueOnce(EMPTY);
    const first = renderHook(() => useReferenceSearch("lake", "pota"));
    await waitFor(() => expect(first.result.current.error).toBe(failure));
    expect(first.result.current).toMatchObject({ search: null, loading: false });
    first.unmount();

    const again = renderHook(() => useReferenceSearch("lake", "pota"));
    await waitFor(() => expect(again.result.current.search).toBe(EMPTY));
    expect(searchReferences).toHaveBeenCalledTimes(2);
  });

  it("drops an answer that arrives after the search changed", async () => {
    let answer: (s: typeof MITCHELL) => void = () => {};
    vi.mocked(searchReferences)
      .mockReturnValueOnce(new Promise((resolve) => {
        answer = resolve;
      }))
      .mockResolvedValueOnce(EMPTY);
    const { result, rerender } = renderHook(({ q }: { q: string }) => useReferenceSearch(q, "sota"), { initialProps: { q: "slow" } });
    rerender({ q: "fast" });
    await waitFor(() => expect(result.current.search).toBe(EMPTY));
    answer(MITCHELL);
    await Promise.resolve();
    expect(result.current.search).toBe(EMPTY);
  });
});
