import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { loadReferenceProfile } from "../lib/api";
import { PARK } from "./fixtures";
import type { ReferenceProfile } from "./types";
import { useReferenceProfile } from "./useReferenceProfile";

vi.mock("../lib/api", () => ({ loadReferenceProfile: vi.fn() }));

// The cache is module state shared by every test here, so each test uses its own references.
const fresh = (reference: string): ReferenceProfile => ({ ...PARK, reference });

beforeEach(() => {
  vi.mocked(loadReferenceProfile).mockReset();
});

describe("useReferenceProfile", () => {
  it("loads a reference once and serves it from the cache next time", async () => {
    vi.mocked(loadReferenceProfile).mockResolvedValue(fresh("US-0001"));
    const first = renderHook(() => useReferenceProfile("pota", "US-0001"));
    expect(first.result.current).toMatchObject({ loading: true, notFound: false, profile: null });
    await waitFor(() => expect(first.result.current.profile?.reference).toBe("US-0001"));
    expect(loadReferenceProfile).toHaveBeenCalledWith("pota", "US-0001");
    first.unmount();

    const again = renderHook(() => useReferenceProfile("pota", "US-0001"));
    expect(again.result.current).toMatchObject({ loading: false, error: null, notFound: false });
    expect(loadReferenceProfile).toHaveBeenCalledTimes(1);
  });

  it("splits a SOTA reference from its program only at the first slash", async () => {
    vi.mocked(loadReferenceProfile).mockResolvedValue({ ...fresh("W4C/CM-002"), program: "sota" });
    const { result } = renderHook(() => useReferenceProfile("sota", "W4C/CM-002"));
    await waitFor(() => expect(result.current.profile?.reference).toBe("W4C/CM-002"));
    expect(loadReferenceProfile).toHaveBeenCalledWith("sota", "W4C/CM-002");
  });

  it("says when there is no such page, and keeps that answer", async () => {
    vi.mocked(loadReferenceProfile).mockResolvedValue(null);
    const first = renderHook(() => useReferenceProfile("pota", "US-27X3"));
    await waitFor(() => expect(first.result.current.notFound).toBe(true));
    expect(first.result.current).toMatchObject({ profile: null, loading: false, error: null });
    first.unmount();
    const again = renderHook(() => useReferenceProfile("pota", "US-27X3"));
    expect(again.result.current.notFound).toBe(true);
    expect(loadReferenceProfile).toHaveBeenCalledTimes(1);
  });

  it("reports a failure and does not keep it", async () => {
    vi.mocked(loadReferenceProfile).mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(fresh("US-0003"));
    const first = renderHook(() => useReferenceProfile("pota", "US-0003"));
    await waitFor(() => expect(first.result.current.error).toBeInstanceOf(Error));
    expect(first.result.current).toMatchObject({ profile: null, loading: false, notFound: false });
    first.unmount();
    const again = renderHook(() => useReferenceProfile("pota", "US-0003"));
    await waitFor(() => expect(again.result.current.profile?.reference).toBe("US-0003"));
  });

  it("ignores a result that lands after the reference changed", async () => {
    let finish: (p: ReferenceProfile) => void = () => {};
    vi.mocked(loadReferenceProfile)
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(fresh("US-0005"));
    const { result, rerender } = renderHook(({ ref }) => useReferenceProfile("pota", ref), { initialProps: { ref: "US-0004" } });
    rerender({ ref: "US-0005" });
    await waitFor(() => expect(result.current.profile?.reference).toBe("US-0005"));
    finish(fresh("US-0004"));
    await Promise.resolve();
    expect(result.current.profile?.reference).toBe("US-0005");
  });
});
