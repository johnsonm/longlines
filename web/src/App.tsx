import { useCallback, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { createTheme, CssBaseline, LinearProgress, Snackbar, ThemeProvider, useMediaQuery } from "@mui/material";
import { Navigate, Route, Routes, useLocation, useParams, useSearchParams } from "react-router";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { Analytics } from "@vercel/analytics/react";
import { AppProvider } from "./app/AppContext";
import { useApp } from "./app/hooks";
import { SignInPage } from "./auth/SignInPage";
import { CheckEmailPage } from "./auth/CheckEmailPage";
import { ResetPasswordPage } from "./auth/ResetPasswordPage";
import { SetPasswordPage } from "./auth/SetPasswordPage";
import { AppShell } from "./layout/AppShell";
import { PublicShell } from "./layout/PublicShell";
import { SourcesPage } from "./sources/SourcesPage";
import { SourceDetailPage } from "./sources/SourceDetailPage";
import { DestinationsPage } from "./destinations/DestinationsPage";
import { SubscriptionsPage } from "./subscriptions/SubscriptionsPage";
import { SubscriptionEditorPage } from "./subscriptions/SubscriptionEditorPage";
import { GroupsPage } from "./groups/GroupsPage";
import { StatsPage } from "./stats/StatsPage";
import { ApiTokensPage } from "./tokens/ApiTokensPage";
import { AccountPage } from "./account/AccountPage";
import { LookupPage } from "./profile/LookupPage";
import { CallsignPage } from "./profile/CallsignPage";
import { loadDestinations, loadSubscriptions, type Destination, type SubscriptionWithLinks } from "./lib/api";
import type { TimePrefs } from "./lib/time";

export default function App() {
  const dark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(() => createTheme({ palette: { mode: dark ? "dark" : "light" } }), [dark]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppProvider>
        <Router />
        <Toast />
      </AppProvider>
      <SpeedInsights />
      <Analytics />
    </ThemeProvider>
  );
}

function Toast() {
  const { toast, clearToast } = useApp();
  return (
    <Snackbar open={!!toast} autoHideDuration={3000} onClose={clearToast} message={toast} anchorOrigin={{ vertical: "bottom", horizontal: "center" }} />
  );
}

function Router() {
  return (
    <Routes>
      <Route path="/signin" element={<PublicOnly><PublicShell><SignInPage /></PublicShell></PublicOnly>} />
      <Route path="/check-email" element={<CheckEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/sources" element={<RequireAuth page="sources" />} />
      <Route path="/sources/:id" element={<RequireAuth page="source" />} />
      <Route path="/subscriptions" element={<RequireAuth page="subscriptions" />} />
      <Route path="/subscriptions/new" element={<RequireAuth page="subscription-new" />} />
      <Route path="/subscriptions/:id" element={<RequireAuth page="subscription" />} />
      <Route path="/groups" element={<RequireAuth page="groups" />} />
      <Route path="/destinations" element={<RequireAuth page="destinations" />} />
      <Route path="/stats" element={<PublicRoute page="stats" />} />
      <Route path="/lookup" element={<PublicRoute page="lookup" />} />
      <Route path="/call/*" element={<PublicRoute page="call" />} />
      <Route path="/account" element={<RequireAuth page="account" />} />
      <Route path="/api-tokens" element={<RequireAuth page="api-tokens" />} />
      <Route path="*" element={<Navigate to="/sources" replace />} />
    </Routes>
  );
}

/** Signed-in users skip the sign-in screen. */
function PublicOnly({ children }: { children: ReactNode }) {
  const { session, sessionLoading } = useApp();
  if (sessionLoading) return <LinearProgress />;
  if (session) return <Navigate to="/sources" replace />;
  return children;
}

type Page = "sources" | "source" | "subscriptions" | "subscription-new" | "subscription" | "groups" | "destinations" | "stats" | "lookup" | "call" | "account" | "api-tokens";
type PublicPage = "stats" | "lookup" | "call";

// Signed-out visitors read profiles in UTC.
const UTC: TimePrefs = { utcTimes: true, timezone: "UTC" };

/** Stats and callsign profiles are public: signed-in users see them inside the app, everyone else in the public shell. */
function PublicRoute({ page }: { page: PublicPage }) {
  const { session, sessionLoading } = useApp();
  if (sessionLoading) return <LinearProgress />;
  if (session) return <RequireAuth page={page} />;
  return (
    <PublicShell>
      {page === "stats" && <StatsPage />}
      {page === "lookup" && <LookupPage />}
      {page === "call" && <CallsignPage prefs={UTC} />}
    </PublicShell>
  );
}

function RequireAuth({ page }: { page: Page }) {
  const { session, sessionLoading, profile } = useApp();
  const location = useLocation();
  if (sessionLoading) return <LinearProgress />;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  if (!profile) return <LinearProgress />;
  return <SignedIn page={page} />;
}

/** The editor takes its id or source as props, so its tests need no router params. */
function SubscriptionRoute(props: Omit<ComponentProps<typeof SubscriptionEditorPage>, "id" | "source">) {
  const { id } = useParams();
  const [search] = useSearchParams();
  return <SubscriptionEditorPage {...props} id={id} source={search.get("source")} />;
}

function SignedIn({ page }: { page: Page }) {
  const { profile, notify } = useApp();
  const mobile = useMediaQuery((t: ReturnType<typeof createTheme>) => t.breakpoints.down("md"));
  const [dests, setDests] = useState<Destination[]>([]);
  const [subs, setSubs] = useState<SubscriptionWithLinks[]>([]);
  const [loading, setLoading] = useState(true);
  const prefs: TimePrefs = { utcTimes: profile?.utc_times ?? true, timezone: profile?.timezone ?? "UTC" };

  const reload = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([loadDestinations(), loadSubscriptions()]);
      setDests(d);
      setSubs(s);
    } catch {
      notify("Couldn't load your destinations and subscriptions.");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!profile) return <LinearProgress />;

  return (
    <AppShell destinationsFailing={dests.some((d) => d.health === "failing")}>
      {page === "sources" && <SourcesPage />}
      {page === "source" && <SourceDetailPage prefs={prefs} subs={subs} />}
      {page === "subscriptions" && (
        <SubscriptionsPage subs={subs} dests={dests} loading={loading} reload={reload} mobile={mobile} />
      )}
      {(page === "subscription-new" || page === "subscription") && (
        <SubscriptionRoute subs={subs} dests={dests} loading={loading} reload={reload} prefs={prefs} mobile={mobile} />
      )}
      {page === "groups" && <GroupsPage reload={reload} />}
      {page === "destinations" && <DestinationsPage dests={dests} subs={subs} loading={loading} reload={reload} />}
      {page === "stats" && <StatsPage />}
      {page === "lookup" && <LookupPage />}
      {page === "call" && <CallsignPage prefs={prefs} account={{ reload }} />}
      {page === "account" && <AccountPage profile={profile} />}
      {page === "api-tokens" && <ApiTokensPage />}
    </AppShell>
  );
}
