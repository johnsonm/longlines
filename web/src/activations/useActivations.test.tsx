import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { loadCallsignActivations, loadSpottedActivation } from "../lib/api";
import { EMPTY_LIST, LIST, TWOFER } from "./fixtures";
import { useCallsignActivations, useSpottedActivation } from "./useActivations";

vi.mock("../lib/api", () => ({ loadSpottedActivation: vi.fn(), loadCallsignActivations: vi.fn() }));

beforeEach(() => {
  vi.mocked(loadSpottedActivation).mockReset();
  vi.mocked(loadCallsignActivations).mockReset();
});

// The caches are module state shared by every test here, so each test uses its own keys.
describe("useSpottedActivation", () => {
  it("loads an activation once and serves it from the cache next time", async () => {
    vi.mocked(loadSpottedActivation).mockResolvedValue(TWOFER);
    const first = renderHook(() => useSpottedActivation("aaaaaaaaaaa1"));
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.data?.id).toBe(TWOFER.id));
    first.unmount();

    const again = renderHook(() => useSpottedActivation("aaaaaaaaaaa1"));
    expect(again.result.current).toMatchObject({ loading: false, notFound: false, error: null });
    expect(loadSpottedActivation).toHaveBeenCalledTimes(1);
  });

  it("reports no such page, and an outage", async () => {
    vi.mocked(loadSpottedActivation).mockResolvedValueOnce(null);
    const missing = renderHook(() => useSpottedActivation("aaaaaaaaaaa2"));
    await waitFor(() => expect(missing.result.current.notFound).toBe(true));
    expect(missing.result.current).toMatchObject({ data: null, loading: false });

    const boom = new Error("down");
    vi.mocked(loadSpottedActivation).mockRejectedValueOnce(boom);
    const failed = renderHook(() => useSpottedActivation("aaaaaaaaaaa3"));
    await waitFor(() => expect(failed.result.current.error).toBe(boom));
    expect(failed.result.current).toMatchObject({ data: null, notFound: false, loading: false });
  });

  it("drops a result for another id", async () => {
    vi.mocked(loadSpottedActivation).mockResolvedValueOnce(TWOFER).mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHook(({ id }) => useSpottedActivation(id), { initialProps: { id: "aaaaaaaaaaa4" } });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    rerender({ id: "aaaaaaaaaaa5" });
    expect(result.current).toMatchObject({ data: null, loading: true });
  });
});

describe("useCallsignActivations", () => {
  it("loads a callsign's list by its base call", async () => {
    vi.mocked(loadCallsignActivations).mockResolvedValue(LIST);
    const { result } = renderHook(() => useCallsignActivations("KK4PWJ"));
    await waitFor(() => expect(result.current.data?.callsign).toBe("KK4PWJ"));
    expect(loadCallsignActivations).toHaveBeenCalledWith("KK4PWJ");
  });

  it("keeps an empty list apart from a missing one", async () => {
    vi.mocked(loadCallsignActivations).mockResolvedValueOnce(EMPTY_LIST);
    const empty = renderHook(() => useCallsignActivations("W1AW"));
    await waitFor(() => expect(empty.result.current.data).toEqual(EMPTY_LIST));
    vi.mocked(loadCallsignActivations).mockResolvedValueOnce(null);
    const hidden = renderHook(() => useCallsignActivations("W1HID"));
    await waitFor(() => expect(hidden.result.current.notFound).toBe(true));
  });
});
