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
import { CompleteProfilePage } from "./auth/CompleteProfilePage";
import { AppShell } from "./layout/AppShell";
import { HomePage } from "./home/HomePage";
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
import { ReferenceLookupPage } from "./references/ReferenceLookupPage";
import { ReferencePage } from "./references/ReferencePage";
import { ApprovePage } from "./relay/ApprovePage";
import { loadDestinations, loadSubscriptions, signOut, type Destination, type SubscriptionWithLinks } from "./lib/api";
import type { TimePrefs } from "./lib/time";
import { pushCleanup } from "./pwa/push";
import { withoutQueryOrHash } from "./lib/analytics";

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
      <SpeedInsights beforeSend={withoutQueryOrHash} />
      <Analytics beforeSend={withoutQueryOrHash} />
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
      <Route path="/home" element={<RequireAuth page="home" />} />
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
      <Route path="/ref" element={<PublicRoute page="ref-lookup" />} />
      <Route path="/ref/:program/*" element={<PublicRoute page="ref" />} />
      <Route path="/g/:slug" element={<PublicRoute page="group-public" />} />
      <Route path="/account" element={<RequireAuth page="account" />} />
      <Route path="/api-tokens" element={<RequireAuth page="api-tokens" />} />
      <Route path="/relay" element={<ToRelayApprove />} />
      <Route path="/relay/approve" element={<RequireAuth page="relay-approve" />} />
      <Route path="*" element={<ToHome />} />
    </Routes>
  );
}

/**
 * Unknown paths go to Home, but only once the session is read: Google's sign-in comes back to
 * the site root with the session in the URL, and leaving first would drop it.
 */
function ToHome() {
  const { sessionLoading } = useApp();
  if (sessionLoading) return <LinearProgress />;
  return <Navigate to="/home" replace />;
}

/** /relay is the short address the relay tells people to type; the page itself is /relay/approve, code and all. */
function ToRelayApprove() {
  const { search, hash } = useLocation();
  return <Navigate to={`/relay/approve${search}${hash}`} replace />;
}

/** Subscriptions are now Connections: old /subscriptions bookmarks keep their id and query string. */
function OldConnectionsPath() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${pathname.replace(/^\/subscriptions/, "/connections")}${search}${hash}`} replace />;
}

/**
 * Signed-in users skip the sign-in screen, to the page they came from (AppShell's Sign in and
 * RequireAuth put it in `from`), the same place SignInPage sends them, so the two never race.
 */
function PublicOnly({ children }: { children: ReactNode }) {
  const { session, sessionLoading } = useApp();
  const { state } = useLocation() as { state: { from?: string } | null };
  if (sessionLoading) return <LinearProgress />;
  if (session) return <Navigate to={state?.from ?? "/home"} replace />;
  return children;
}

type Page = "home" | "sources" | "source" | "band-map" | "subscriptions" | "subscription-new" | "subscription" | "groups" | "group" | "group-settings" | "destinations" | "destination-new" | "destination" | "stats" | "health" | "lookup" | "call" | "ref-lookup" | "ref" | "account" | "api-tokens" | "group-public" | "relay-approve";
type PublicPage = "band-map" | "stats" | "health" | "lookup" | "call" | "ref-lookup" | "ref" | "group-public";

// Signed-out visitors read profiles in UTC.
const UTC: TimePrefs = { utcTimes: true, timezone: "UTC" };

/** The band map, Stats, Health, callsign and reference profiles and public group pages are public: signed out, AppShell shows them with the other sections disabled. */
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
      {page === "ref-lookup" && <ReferenceLookupPage />}
      {page === "ref" && <ReferencePage signedIn={false} />}
      {page === "group-public" && <PublicGroupRoute />}
    </AppShell>
  );
}

function RequireAuth({ page }: { page: Page }) {
  const { session, sessionLoading, profile, profileError, profileMissing } = useApp();
  const location = useLocation();
  if (sessionLoading) return <LinearProgress />;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search + location.hash }} />;
  if (profileError) return <ProfileError message={profileError} />;
  if (profileMissing) return <CompleteProfilePage />;
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
function SubscriptionRoute(props: Omit<ComponentProps<typeof SubscriptionEditorPage>, "id" | "source" | "callsign" | "group" | "reference">) {
  const { id } = useParams();
  const [search] = useSearchParams();
  return (
    <SubscriptionEditorPage
      {...props} id={id} source={search.get("source")} callsign={search.get("callsign")} group={search.get("group")}
      reference={search.get("reference")}
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

const LOAD_FAILED = "Couldn't load your destinations and connections.";
const LIST_PAGES = new Set<Page>(["home", "subscriptions", "subscription-new", "subscription", "destinations", "destination-new", "destination"]);

/** A failed load in place of the page, with Retry. */
function LoadError({ message, retry }: { message: string; retry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    try {
      await retry();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert
      severity="error"
      action={<Button color="inherit" size="small" disabled={busy} onClick={() => void again()}>Retry</Button>}
    >
      {message}
    </Alert>
  );
}

function SignedIn({ page }: { page: Page }) {
  const { profile, notify } = useApp();
  const mobile = useMediaQuery((t: ReturnType<typeof createTheme>) => t.breakpoints.down("md"));
  const [dests, setDests] = useState<Destination[]>([]);
  const [subs, setSubs] = useState<SubscriptionWithLinks[]>([]);
  // "failed" only until the first successful load: a later failed reload keeps the lists it has and only toasts.
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const loading = status === "loading";
  const prefs: TimePrefs = { utcTimes: profile?.utc_times ?? true, timezone: profile?.timezone ?? "UTC" };

  const reload = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([loadDestinations(), loadSubscriptions()]);
      setDests(d);
      setSubs(s);
      setStatus("ready");
    } catch {
      notify(LOAD_FAILED);
      setStatus((was) => (was === "ready" ? "ready" : "failed"));
    }
  }, [notify]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!profile) return <LinearProgress />;

  // Pages built on these lists would show a failed load as "none yet", and an editor's id would bounce to the list.
  if (status === "failed" && LIST_PAGES.has(page)) {
    return (
      <AppShell>
        <LoadError message={LOAD_FAILED} retry={reload} />
      </AppShell>
    );
  }

  return (
    <AppShell destinationsFailing={dests.some((d) => d.health === "failing")}>
      {page === "home" && <HomePage subs={subs} dests={dests} loading={loading} />}
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
      {page === "ref-lookup" && <ReferenceLookupPage />}
      {page === "ref" && <ReferencePage signedIn />}
      {page === "account" && <AccountPage profile={profile} />}
      {page === "api-tokens" && <ApiTokensPage />}
      {page === "group-public" && <PublicGroupRoute />}
      {page === "relay-approve" && <ApprovePage />}
    </AppShell>
  );
}
