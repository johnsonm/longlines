// Renders a component inside the providers every page expects: a theme, a
// MemoryRouter, and a stub App context whose callbacks are vi.fn()s.

import type { ReactElement, ReactNode } from "react";
import { createTheme, ThemeProvider } from "@mui/material";
import { render, type RenderResult } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import type { Session } from "@supabase/supabase-js";
import { vi } from "vitest";
import { AppContext, type AppContextValue } from "../app/context";
import type { Profile } from "../lib/api";
import { LocationProbe } from "./LocationProbe";

export const PROFILE: Profile = {
  id: "u1",
  callsign: "KK4PWJ",
  name: "Brad",
  timezone: "UTC",
  utc_times: true,
  created_at: "2026-10-01T00:00:00Z",
};

export const SESSION = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 3600,
  token_type: "bearer",
  user: { id: "u1", email: "kk4pwj@example.com", last_sign_in_at: "2026-10-05T12:00:00Z" },
} as unknown as Session;

export function appValue(overrides: Partial<AppContextValue> = {}): AppContextValue {
  return {
    session: SESSION,
    sessionLoading: false,
    profile: PROFILE,
    refreshProfile: vi.fn(() => Promise.resolve()),
    notify: vi.fn(),
    toast: null,
    clearToast: vi.fn(),
    signInNotice: null,
    setSignInNotice: vi.fn(),
    ...overrides,
  };
}

export interface Options {
  app?: Partial<AppContextValue>;
  route?: string;
  state?: unknown;
}

export interface Rendered extends RenderResult {
  app: AppContextValue;
  user: UserEvent;
}

export function wrap(children: ReactNode, app: AppContextValue): ReactElement {
  return (
    <ThemeProvider theme={createTheme()}>
      <AppContext.Provider value={app}>
        {children}
      </AppContext.Provider>
    </ThemeProvider>
  );
}

export function renderPage(ui: ReactElement, options: Options = {}): Rendered {
  const app = appValue(options.app);
  const route = options.route ?? "/";
  // No per-keystroke timer: typing into MUI inputs is slow enough under coverage instrumentation.
  const user = userEvent.setup({ delay: null });
  const result = render(
    wrap(
      <MemoryRouter initialEntries={[{ pathname: route, state: options.state }]}>
        <Routes>
          <Route path={route} element={ui} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
      app,
    ),
  );
  return { ...result, app, user };
}
