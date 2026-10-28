import { createContext } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Profile } from "../lib/api";

export interface AppContextValue {
  session: Session | null;
  sessionLoading: boolean;
  profile: Profile | null;
  /** Why the signed-in user's profile failed to load; null while loading or once loaded. */
  profileError: string | null;
  /** Signed in with no profile yet: an account made with Google, before it picks a callsign. */
  profileMissing: boolean;
  refreshProfile: () => Promise<void>;
  notify: (message: string) => void;
  toast: string | null;
  clearToast: () => void;
  /** Shown once on the sign-in page after a signed-out transition (e.g. account deleted). */
  signInNotice: string | null;
  setSignInNotice: (notice: string | null) => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

