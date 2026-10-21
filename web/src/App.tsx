import { useCallback, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Alert, Box, Button, createTheme, CssBaseline, LinearProgress, Snackbar, ThemeProvider, useMediaQuery } from "@mui/material";
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
import { SourcesPage } from "./sources/SourcesPage";
import { SourceDetailPage } from "./sources/SourceDetailPage";
import { DestinationsPage } from "./destinations/DestinationsPage";
import { PushDestinationPage } from "./destinations/PushDestinationPage";
import { DiscordDestinationPage } from "./destinations/DiscordDestinationPage";
import { WebhookDestinationPage } from "./destinations/WebhookDestinationPage";
import { SubscriptionsPage } from "./subscriptions/SubscriptionsPage";
import { SubscriptionEditorPage } from "./subscriptions/SubscriptionEditorPage";
import { GroupsPage } from "./groups/GroupsPage";
import { GroupPage } from "./groups/GroupPage";
import { PublicGroupPage } from "./groups/PublicGroupPage";
import { StatsPage } from "./stats/StatsPage";
import { BandMapPage } from "./bandmap/BandMapPage";
import { HealthPage } from "./health/HealthPage";
import { ApiTokensPage } from "./tokens/ApiTokensPage";
import { AccountPage } from "./account/AccountPage";
import { LookupPage } from "./profile/LookupPage";
import { CallsignPage } from "./profile/CallsignPage";
import { loadDestinations, loadSubscriptions, signOut, type Destination, type SubscriptionWithLinks } from "./lib/api";
import type { TimePrefs } from "./lib/time";
import { pushCleanup } from "./pwa/push";

// Both schemes, so useColorScheme() can pick light, dark or system; MUI keeps the choice in localStorage.
const theme = createTheme({ colorSchemes: { light: true, dark: true } });

export default function App() {
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
      <Route path="/signin" element={<PublicOnly><AppShell><SignInPage /></AppShell></PublicOnly>} />
      <Route path="/check-email" element={<CheckEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/sources" element={<RequireAuth page="sources" />} />
      <Route path="/sources/:id" element={<RequireAuth page="source" />} />
      <Route path="/connections" element={<RequireAuth page="subscriptions" />} />
      <Route path="/connections/new" element={<RequireAuth page="subscription-new" />} />
      <Route path="/connections/:id" element={<RequireAuth page="subscription" />} />
      <Route path="/subscriptions/*" element={<OldConnectionsPath />} />
      <Route path="/groups" element={<RequireAuth page="groups" />} />
      <Route path="/groups/:id" element={<RequireAuth page="group" />} />
      <Route path="/groups/:id/settings" element={<RequireAuth page="group-settings" />} />
      <Route path="/destinations" element={<RequireAuth page="destinations" />} />
      <Route path="/destinations/new" element={<RequireAuth page="destination-new" />} />
      <Route path="/destinations/:id" element={<RequireAuth page="destination" />} />
      <Route path="/band-map" element={<PublicRoute page="band-map" />} />
      <Route path="/stats" element={<PublicRoute page="stats" />} />
      <Route path="/health" element={<PublicRoute page="health" />} />
      <Route path="/lookup" element={<PublicRoute page="lookup" />} />
      <Route path="/call/*" element={<PublicRoute page="call" />} />
      <Route path="/g/:slug" element={<PublicRoute page="group-public" />} />
      <Route path="/account" element={<RequireAuth page="account" />} />
      <Route path="/api-tokens" element={<RequireAuth page="api-tokens" />} />
      <Route path="*" element={<Navigate to="/sources" replace />} />
    </Routes>
  );
}

/** Subscriptions are now Connections: old /subscriptions bookmarks keep their id and query string. */
function OldConnectionsPath() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${pathname.replace(/^\/subscriptions/, "/connections")}${search}${hash}`} replace />;
}

/** Signed-in users skip the sign-in screen. */
function PublicOnly({ children }: { children: ReactNode }) {
  const { session, sessionLoading } = useApp();
  if (sessionLoading) return <LinearProgress />;
  if (session) return <Navigate to="/sources" replace />;
  return children;
}

type Page = "sources" | "source" | "band-map" | "subscriptions" | "subscription-new" | "subscription" | "groups" | "group" | "group-settings" | "destinations" | "destination-new" | "destination" | "stats" | "health" | "lookup" | "call" | "account" | "api-tokens" | "group-public";
type PublicPage = "band-map" | "stats" | "health" | "lookup" | "call" | "group-public";

// Signed-out visitors read profiles in UTC.
const UTC: TimePrefs = { utcTimes: true, timezone: "UTC" };

/** The band map, Stats, Health, callsign profiles and public group pages are public: signed out, AppShell shows them with the other sections disabled. */
function PublicRoute({ page }: { page: PublicPage }) {
  const { session, sessionLoading } = useApp();
  if (sessionLoading) return <LinearProgress />;
  if (session) return <RequireAuth page={page} />;
  return (
    <AppShell>
      {page === "band-map" && <BandMapPage />}
      {page === "stats" && <StatsPage />}
      {page === "health" && <HealthPage />}
      {page === "lookup" && <LookupPage />}
      {page === "call" && <CallsignPage prefs={UTC} />}
      {page === "group-public" && <PublicGroupRoute />}
    </AppShell>
  );
}

function RequireAuth({ page }: { page: Page }) {
  const { session, sessionLoading, profile, profileError } = useApp();
  const location = useLocation();
  if (sessionLoading) return <LinearProgress />;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search + location.hash }} />;
  if (profileError) return <ProfileError message={profileError} />;
  if (!profile) return <LinearProgress />;
  return <SignedIn page={page} />;
}

/** Without a profile there is no shell to sign out from, so the error offers both ways out. */
function ProfileError({ message }: { message: string }) {
  const { refreshProfile, notify } = useApp();
  return (
    <Box sx={{ p: 2 }}>
      <Alert
        severity="error"
        action={
          <>
            <Button color="inherit" size="small" onClick={() => void refreshProfile()}>Retry</Button>
            <Button color="inherit" size="small" onClick={() => void signOut("local", pushCleanup).catch(() => notify("Couldn't sign out. Try again."))}>
              Sign out
            </Button>
          </>
        }
      >
        {message}
      </Alert>
    </Box>
  );
}

/** A public group page takes its code as a prop, so its tests need no router params. */
function PublicGroupRoute() {
  const { slug } = useParams();
  return <PublicGroupPage key={slug} slug={slug ?? ""} />;
}

/** A group's page takes its id as a prop, so its tests need no router params. */
function GroupRoute({ tab }: { tab: "statistics" | "settings" }) {
  const { id } = useParams();
  return id ? <GroupPage key={id} id={id} tab={tab} /> : <Navigate to="/groups" replace />;
}

/** The editor takes its id or source as props, so its tests need no router params. */
function SubscriptionRoute(props: Omit<ComponentProps<typeof SubscriptionEditorPage>, "id" | "source" | "callsign" | "group">) {
  const { id } = useParams();
  const [search] = useSearchParams();
  return (
    <SubscriptionEditorPage
      {...props} id={id} source={search.get("source")} callsign={search.get("callsign")} group={search.get("group")}
    />
  );
}

/**
 * The destination editors likewise, picked by type: a Discord id or ?type=discord opens the Discord
 * editor, a webhook id or ?type=webhook the webhook editor, a push id or ?type=push the push editor.
 * Anything else (an unknown id or type) goes back to the list once the destinations have loaded.
 */
function DestinationRoute(props: Omit<ComponentProps<typeof PushDestinationPage>, "id" | "type">) {
  const { id } = useParams();
  const [search] = useSearchParams();
  const kind = id ? props.dests.find((d) => d.id === id)?.type : search.get("type");
  if (kind === "discord") return <DiscordDestinationPage {...props} id={id} type={search.get("type")} />;
  if (kind === "webhook") return <WebhookDestinationPage {...props} id={id} type={search.get("type")} />;
  if (kind === "push") return <PushDestinationPage {...props} id={id} type={search.get("type")} />;
  if (id && kind === undefined && props.loading) return <LinearProgress />;
  return <Navigate to="/destinations" replace />;
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
      notify("Couldn't load your destinations and connections.");
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
      {page === "band-map" && <BandMapPage />}
      {page === "subscriptions" && (
        <SubscriptionsPage subs={subs} dests={dests} loading={loading} reload={reload} mobile={mobile} />
      )}
      {(page === "subscription-new" || page === "subscription") && (
        <SubscriptionRoute subs={subs} dests={dests} loading={loading} reload={reload} prefs={prefs} mobile={mobile} />
      )}
      {page === "groups" && <GroupsPage />}
      {/* One slot for both tabs, so switching tabs keeps the page and its loaded statistics. */}
      {(page === "group" || page === "group-settings") && <GroupRoute tab={page === "group" ? "statistics" : "settings"} />}
      {page === "destinations" && <DestinationsPage dests={dests} subs={subs} loading={loading} reload={reload} />}
      {(page === "destination-new" || page === "destination") && (
        <DestinationRoute dests={dests} loading={loading} reload={reload} mobile={mobile} />
      )}
      {page === "stats" && <StatsPage />}
      {page === "health" && <HealthPage />}
      {page === "lookup" && <LookupPage />}
      {page === "call" && <CallsignPage prefs={prefs} signedIn />}
      {page === "account" && <AccountPage profile={profile} />}
      {page === "api-tokens" && <ApiTokensPage />}
      {page === "group-public" && <PublicGroupRoute />}
    </AppShell>
  );
}
