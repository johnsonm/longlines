import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { Session } from "@supabase/supabase-js";
import { useSession } from "../auth/useSession";
import { loadProfile } from "../lib/api";
import { refreshPushRegistration } from "../pwa/push";
import { PROFILE, SESSION } from "../test/render";
import { AppProvider } from "./AppContext";
import { errorText, useApp, useNotify } from "./hooks";

vi.mock("../auth/useSession", () => ({ useSession: vi.fn() }));
vi.mock("../lib/api", () => ({ loadProfile: vi.fn() }));
vi.mock("../pwa/push", () => ({ refreshPushRegistration: vi.fn() }));

function session(value: Session | null, loading = false) {
  vi.mocked(useSession).mockReturnValue({ session: value, loading });
}

beforeEach(() => {
  vi.mocked(loadProfile).mockReset().mockResolvedValue(PROFILE);
  vi.mocked(refreshPushRegistration).mockReset().mockResolvedValue(undefined);
  session(SESSION);
});

const hook = () => renderHook(() => ({ app: useApp(), notify: useNotify() }), { wrapper: AppProvider });

describe("AppProvider", () => {
  it("loads the signed-in user's profile", async () => {
    const { result } = hook();
    await waitFor(() => expect(result.current.app.profile).toEqual(PROFILE));
    expect(loadProfile).toHaveBeenCalledWith("u1");
    expect(result.current.app.session).toBe(SESSION);
  });

  it("has no profile when signed out", async () => {
    session(null, true);
    const { result } = hook();
    await act(() => result.current.app.refreshProfile());
    expect(result.current.app.profile).toBeNull();
    expect(result.current.app.sessionLoading).toBe(true);
    expect(loadProfile).not.toHaveBeenCalled();
    expect(refreshPushRegistration).not.toHaveBeenCalled();
  });

  it("refreshes this browser's push registration once per load, with a session", async () => {
    const { result, rerender } = hook();
    await waitFor(() => expect(result.current.app.profile).toEqual(PROFILE));
    expect(refreshPushRegistration).toHaveBeenCalledTimes(1);
    rerender();
    await act(() => result.current.app.refreshProfile());
    expect(refreshPushRegistration).toHaveBeenCalledTimes(1);
  });

  it("refreshes the push registration when a session arrives after load", async () => {
    session(null, true);
    const { rerender } = hook();
    expect(refreshPushRegistration).not.toHaveBeenCalled();
    session(SESSION);
    rerender();
    await waitFor(() => expect(refreshPushRegistration).toHaveBeenCalledTimes(1));
  });

  it("reports a failed profile load, and clears it on a successful retry", async () => {
    vi.mocked(loadProfile).mockRejectedValueOnce(new Error("x"));
    const { result } = hook();
    await waitFor(() => expect(result.current.app.profileError).toBe("x"));
    expect(result.current.app.profile).toBeNull();
    await act(() => result.current.app.refreshProfile());
    expect(result.current.app.profileError).toBeNull();
    expect(result.current.app.profile).toEqual(PROFILE);
  });

  it("falls back to fixed copy for an error without a message", async () => {
    vi.mocked(loadProfile).mockRejectedValue("boom");
    const { result } = hook();
    await waitFor(() => expect(result.current.app.profileError).toBe("Couldn't load your profile."));
  });

  it("hides the previous user's profile as soon as the user changes", async () => {
    vi.mocked(loadProfile).mockImplementation((id) => (id === "u1" ? Promise.resolve(PROFILE) : new Promise(() => {})));
    const { result, rerender } = hook();
    await waitFor(() => expect(result.current.app.profile).toEqual(PROFILE));
    session({ ...SESSION, user: { ...SESSION.user, id: "u2" } } as Session);
    rerender();
    expect(result.current.app.profile).toBeNull();
    expect(result.current.app.profileError).toBeNull();
  });

  it("ignores the previous user's late response", async () => {
    let finishOld: (p: typeof PROFILE) => void = () => {};
    const other = { ...PROFILE, id: "u2", callsign: "W1AW" };
    vi.mocked(loadProfile).mockImplementation((id) =>
      id === "u1" ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(other)
    );
    const { result, rerender } = hook();
    const staleRefresh = result.current.app.refreshProfile;
    session({ ...SESSION, user: { ...SESSION.user, id: "u2" } } as Session);
    rerender();
    expect(result.current.app.profile).toBeNull();
    await waitFor(() => expect(result.current.app.profile).toEqual(other));
    await act(async () => finishOld(PROFILE));
    expect(result.current.app.profile).toEqual(other);
    // A callback held from before the switch does nothing.
    await act(() => staleRefresh());
    expect(loadProfile).toHaveBeenCalledTimes(2);
    expect(result.current.app.profile).toEqual(other);
  });

  it("ignores an older response for the same user once a newer request is out", async () => {
    let finishFirst: (p: typeof PROFILE) => void = () => {};
    const newer = { ...PROFILE, name: "Newer" };
    vi.mocked(loadProfile)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(newer);
    const { result } = hook();
    await act(() => result.current.app.refreshProfile());
    expect(result.current.app.profile).toEqual(newer);
    await act(async () => finishFirst(PROFILE));
    expect(result.current.app.profile).toEqual(newer);
  });

  it("holds the toast and the sign-in notice", () => {
    const { result } = hook();
    act(() => result.current.notify("Saved"));
    expect(result.current.app.toast).toBe("Saved");
    act(() => result.current.app.clearToast());
    expect(result.current.app.toast).toBeNull();
    act(() => result.current.app.setSignInNotice("bye"));
    expect(result.current.app.signInNotice).toBe("bye");
  });
});

describe("app hooks", () => {
  it("useApp throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useApp();
      return null;
    }
    expect(() => render(<Bare />)).toThrow("useApp must be used inside AppProvider");
  });

  it("errorText prefers the error's message", () => {
    expect(errorText(new Error("specific"), "fallback")).toBe("specific");
    expect(errorText(new Error(""), "fallback")).toBe("fallback");
    expect(errorText("string", "fallback")).toBe("fallback");
  });
});
