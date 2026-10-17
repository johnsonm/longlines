import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppContext, type AppContextValue } from "./context";
import { errorText } from "./hooks";
import { loadProfile, type Profile } from "../lib/api";
import { useSession } from "../auth/useSession";
import { refreshPushRegistration } from "../pwa/push";

// A load's result, kept with the user it belongs to so a switch of user hides it at once.
type ProfileLoad = { userId: string; profile: Profile | null; error: string | null };

export function AppProvider({ children }: { children: ReactNode }) {
  const { session, loading: sessionLoading } = useSession();
  const [load, setLoad] = useState<ProfileLoad | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const userId = session?.user.id ?? null;
  // The user whose profile is wanted, and the latest request for it: an older response is dropped.
  const currentUser = useRef<string | null>(null);
  const latest = useRef(0);
  // Once per load, with a session: this browser's push device re-registers its keys (or reports itself blocked).
  const pushRefreshed = useRef(false);

  const refreshProfile = useCallback(async () => {
    // A caller holding a callback from before a user switch must not disturb the new user's load.
    if (userId !== currentUser.current) return;
    const request = ++latest.current;
    if (!userId) {
      setLoad(null);
      return;
    }
    setLoad((prev) => (prev?.userId === userId ? { ...prev, error: null } : null));
    try {
      const profile = await loadProfile(userId);
      if (request === latest.current) setLoad({ userId, profile, error: null });
    } catch (err) {
      if (request === latest.current) {
        setLoad({ userId, profile: null, error: errorText(err, "Couldn't load your profile.") });
      }
    }
  }, [userId]);

  useEffect(() => {
    currentUser.current = userId;
    void refreshProfile();
  }, [userId, refreshProfile]);

  useEffect(() => {
    if (!userId || pushRefreshed.current) return;
    pushRefreshed.current = true;
    void refreshPushRegistration();
  }, [userId]);

  const own = load && load.userId === userId ? load : null;
  const profile = own?.profile ?? null;
  const profileError = own?.error ?? null;

  const value = useMemo<AppContextValue>(() => ({
    session,
    sessionLoading,
    profile,
    profileError,
    refreshProfile,
    notify: setToast,
    toast,
    clearToast: () => setToast(null),
    signInNotice,
    setSignInNotice,
  }), [session, sessionLoading, profile, profileError, refreshProfile, toast, signInNotice]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
