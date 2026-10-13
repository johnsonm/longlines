import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { loadCallsignProfile } from "../lib/api";
import { FULL } from "./fixtures";
import { useCallsignProfile } from "./useCallsignProfile";

vi.mock("../lib/api", () => ({ loadCallsignProfile: vi.fn() }));

// The cache is module state shared by every test here, so each test uses its own callsigns.
const fresh = (callsign: string) => ({ ...FULL, callsign, generatedAt: new Date().toISOString() });

beforeEach(() => {
  vi.mocked(loadCallsignProfile).mockReset();
});

describe("useCallsignProfile", () => {
  it("loads a profile and serves it from the cache next time", async () => {
    vi.mocked(loadCallsignProfile).mockResolvedValue(fresh("W1AW"));
    const first = renderHook(() => useCallsignProfile("W1AW"));
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.profile?.callsign).toBe("W1AW"));
    first.unmount();

    const again = renderHook(() => useCallsignProfile("W1AW"));
    expect(again.result.current).toMatchObject({ loading: false, error: null });
    expect(loadCallsignProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps a portable lookup under the base call too, so the redirect costs no request", async () => {
    vi.mocked(loadCallsignProfile).mockResolvedValue(fresh("K4SWL"));
    const { result, rerender } = renderHook(({ call }) => useCallsignProfile(call), { initialProps: { call: "K4SWL/P" } });
    await waitFor(() => expect(result.current.profile?.callsign).toBe("K4SWL"));
    rerender({ call: "K4SWL" });
    expect(result.current.profile?.callsign).toBe("K4SWL");
    expect(loadCallsignProfile).toHaveBeenCalledTimes(1);
  });

  it("reports a failure and does not keep it", async () => {
    vi.mocked(loadCallsignProfile).mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(fresh("N0CALL"));
    const first = renderHook(() => useCallsignProfile("N0CALL"));
    await waitFor(() => expect(first.result.current.error).toBeInstanceOf(Error));
    expect(first.result.current).toMatchObject({ profile: null, loading: false });
    first.unmount();
    const again = renderHook(() => useCallsignProfile("N0CALL"));
    await waitFor(() => expect(again.result.current.profile?.callsign).toBe("N0CALL"));
  });

  it("ignores a result that lands after the callsign changed", async () => {
    let finish: (p: typeof FULL) => void = () => {};
    vi.mocked(loadCallsignProfile)
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(fresh("AA1B"));
    const { result, rerender } = renderHook(({ call }) => useCallsignProfile(call), { initialProps: { call: "AA1A" } });
    rerender({ call: "AA1B" });
    await waitFor(() => expect(result.current.profile?.callsign).toBe("AA1B"));
    finish(fresh("AA1A"));
    await Promise.resolve();
    expect(result.current.profile?.callsign).toBe("AA1B");
  });
});
