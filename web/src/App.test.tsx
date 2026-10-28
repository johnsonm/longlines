import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { Session } from "@supabase/supabase-js";
import App from "./App";
import { useSession } from "./auth/useSession";
import { loadDestinations, loadProfile, loadSubscriptions, signOut, type Destination } from "./lib/api";
import { pushCleanup } from "./pwa/push";
import { withoutQueryOrHash } from "./lib/analytics";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { PROFILE, SESSION } from "./test/render";

vi.mock("./auth/useSession", () => ({ useSession: vi.fn() }));
vi.mock("./lib/api", () => ({ loadProfile: vi.fn(), loadDestinations: vi.fn(), loadSubscriptions: vi.fn(), signOut: vi.fn() }));
vi.mock("@vercel/speed-insights/react", () => ({ SpeedInsights: vi.fn(() => null) }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: vi.fn(() => null) }));

// App's job is routing and loading shared data; each page has its own tests.
// The stubs show which page rendered and the props App passed it.
vi.mock("./auth/SignInPage", async () => {
  const { useLocation } = await import("react-router");
  return {
    SignInPage: () => <p>sign-in page {(useLocation().state as { from?: string } | null)?.from ?? ""}</p>,
  };
});
vi.mock("./auth/CheckEmailPage", () => ({ CheckEmailPage: () => <p>check-email page</p> }));
vi.mock("./auth/ResetPasswordPage", () => ({ ResetPasswordPage: () => <p>reset page</p> }));
vi.mock("./auth/SetPasswordPage", () => ({ SetPasswordPage: () => <p>set-password page</p> }));
vi.mock("./auth/CompleteProfilePage", () => ({ CompleteProfilePage: () => <p>complete-profile page</p> }));
vi.mock("./home/HomePage", () => ({
  HomePage: ({ subs, dests, loading }: { subs: unknown[]; dests: Destination[]; loading: boolean }) => (
    <p>home page {loading ? "loading" : `${subs.length} connections, ${dests.length} destinations`}</p>
  ),
}));
vi.mock("./sources/SourcesPage", () => ({
  SourcesPage: () => <p>sources page</p>,
}));
vi.mock("./sources/SourceDetailPage", () => ({
  SourceDetailPage: ({ prefs }: { prefs: { timezone: string } }) => <p>source page {prefs.timezone}</p>,
}));
vi.mock("./destinations/DestinationsPage", () => ({
  DestinationsPage: ({ dests, loading, reload }: { dests: Destination[]; loading: boolean; reload: () => Promise<void> }) => (
    <>
      <p>destinations page {loading ? "loading" : dests.map((d) => d.name).join(",")}</p>
      <button type="button" onClick={() => void reload()}>reload</button>
    </>
  ),
}));
vi.mock("./destinations/PushDestinationPage", () => ({
  PushDestinationPage: ({ id, type }: { id?: string; type?: string | null }) => <p>push editor {id ?? "new"} {type ?? "none"}</p>,
}));
vi.mock("./destinations/LocalClusterDestinationPage", () => ({
  LocalClusterDestinationPage: ({ id, type }: { id?: string; type?: string | null }) => <p>cluster editor {id ?? "new"} {type ?? "none"}</p>,
}));
vi.mock("./destinations/DiscordDestinationPage", () => ({
  DiscordDestinationPage: ({ id, type }: { id?: string; type?: string | null }) => <p>discord editor {id ?? "new"} {type ?? "none"}</p>,
}));
vi.mock("./destinations/WebhookDestinationPage", () => ({
  WebhookDestinationPage: ({ id, type }: { id?: string; type?: string | null }) => <p>webhook editor {id ?? "new"} {type ?? "none"}</p>,
}));
vi.mock("./subscriptions/SubscriptionsPage", () => ({
  SubscriptionsPage: ({ subs }: { subs: unknown[] }) => <p>subscriptions page {subs.length}</p>,
}));
vi.mock("./subscriptions/SubscriptionEditorPage", () => ({
  SubscriptionEditorPage: (
    { id, source, callsign, group, reference }: { id?: string; source?: string | null; callsign?: string | null; group?: string | null; reference?: string | null },
  ) => (
    <p>subscription editor {id ?? "new"} {source ?? "none"} {callsign ?? "any"}{group ? ` group ${group}` : ""}{reference ? ` reference ${reference}` : ""}</p>
  ),
}));
vi.mock("./groups/GroupsPage", () => ({ GroupsPage: () => <p>groups page</p> }));
vi.mock("./groups/GroupPage", () => ({ GroupPage: ({ id, tab }: { id: string; tab: string }) => <p>group page {id} {tab}</p> }));
vi.mock("./groups/PublicGroupPage", () => ({ PublicGroupPage: ({ slug }: { slug: string }) => <p>public group page {slug}</p> }));
vi.mock("./stats/StatsPage", () => ({ StatsPage: () => <p>stats page</p> }));
vi.mock("./health/HealthPage", () => ({ HealthPage: () => <p>health page</p> }));
vi.mock("./account/AccountPage", () => ({ AccountPage: () => <p>account page</p> }));
vi.mock("./relay/ApprovePage", async () => {
  const { useLocation } = await import("react-router");
  return { ApprovePage: () => <p>relay approve page {useLocation().search}</p> };
});
vi.mock("./profile/LookupPage", () => ({ LookupPage: () => <p>lookup page</p> }));
vi.mock("./references/ReferenceLookupPage", () => ({ ReferenceLookupPage: () => <p>reference lookup page</p> }));
vi.mock("./references/ReferencePage", async () => {
  const { useParams } = await import("react-router");
  return {
    ReferencePage: ({ signedIn }: { signedIn: boolean }) => {
      const params = useParams();
      return <p>reference page {params.program} {params["*"]} {signedIn ? "signed in" : "signed out"}</p>;
    },
  };
});
vi.mock("./profile/CallsignPage", () => ({
  CallsignPage: ({ prefs, signedIn }: { prefs: { timezone: string }; signedIn?: boolean }) => (
    <p>callsign page {prefs.timezone} {signedIn ? "signed in" : "signed out"}</p>
  ),
}));

function session(value: Session | null, loading = false) {
  vi.mocked(useSession).mockReturnValue({ session: value, loading });
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const DEST = { id: "d1", name: "Shack", health: "ok" } as Destination;

beforeEach(() => {
  localStorage.clear();
  session(SESSION);
  vi.mocked(loadProfile).mockReset().mockResolvedValue({ ...PROFILE, timezone: "Asia/Tokyo" });
  vi.mocked(loadDestinations).mockReset().mockResolvedValue([DEST]);
  vi.mocked(loadSubscriptions).mockReset().mockResolvedValue([]);
  vi.mocked(signOut).mockReset().mockResolvedValue();
});

describe("App analytics", () => {
  it("strips the query string and hash from what Analytics and Speed Insights report", async () => {
    renderAt("/stats");
    await screen.findByText("stats page");
    expect(vi.mocked(Analytics).mock.calls[0]![0]).toEqual({ beforeSend: withoutQueryOrHash });
    expect(vi.mocked(SpeedInsights).mock.calls[0]![0]).toEqual({ beforeSend: withoutQueryOrHash });
  });
});

describe("App routing", () => {
  it("sends signed-out visitors to sign in", async () => {
    session(null);
    renderAt("/destinations");
    expect(await screen.findByText("sign-in page /destinations")).toBeInTheDocument();
  });

  it("comes back to the whole address after sign in, query string and hash included", async () => {
    session(null);
    renderAt("/connections/new?source=rbn&callsign=KK4PWJ#top");
    expect(await screen.findByText("sign-in page /connections/new?source=rbn&callsign=KK4PWJ#top")).toBeInTheDocument();
  });

  it("serves the relay approval page signed in, keeping the code", async () => {
    renderAt("/relay/approve?code=KQ7M-X4PD");
    expect(await screen.findByText("relay approve page ?code=KQ7M-X4PD")).toBeInTheDocument();
  });

  it("sends /relay to the approval page with its code", async () => {
    renderAt("/relay?code=KQ7M-X4PD");
    expect(await screen.findByText("relay approve page ?code=KQ7M-X4PD")).toBeInTheDocument();
  });

  it("sends a signed-out visitor from the relay's link to sign in, and back with the code", async () => {
    session(null);
    renderAt("/relay/approve?code=KQ7M-X4PD");
    expect(await screen.findByText("sign-in page /relay/approve?code=KQ7M-X4PD")).toBeInTheDocument();
  });

  it("renders a source's detail page at /sources/:id", async () => {
    renderAt("/sources/rbn");
    expect(await screen.findByText("source page Asia/Tokyo")).toBeInTheDocument();
  });

  it("shows progress while the session is loading", () => {
    session(null, true);
    renderAt("/sources");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows progress on public-only and stats routes while the session loads", () => {
    session(null, true);
    renderAt("/signin");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("sends signed-in users from sign in to Home", async () => {
    renderAt("/signin");
    expect(await screen.findByText(/^home page/)).toBeInTheDocument();
  });

  it("sends a new session on sign in back to the page it came from, where SignInPage sends it", async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/signin", state: { from: "/stats" } }]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("stats page")).toBeInTheDocument();
  });

  it("redirects unknown paths to Home", async () => {
    renderAt("/nope");
    expect(await screen.findByText(/^home page/)).toBeInTheDocument();
  });

  it("holds the site root until the session is read, so Google's sign-in can take it from the URL", async () => {
    session(null, true);
    const { rerender } = renderAt("/");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    session(SESSION);
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/^home page/)).toBeInTheDocument();
  });

  it("asks an account without a profile for its callsign before any signed-in page", async () => {
    vi.mocked(loadProfile).mockResolvedValue(null);
    renderAt("/destinations");
    expect(await screen.findByText("complete-profile page")).toBeInTheDocument();
    expect(screen.queryByText(/^destinations page/)).not.toBeInTheDocument();
  });

  it("keeps Home for signed-in users and sends signed-out visitors from it to sign in", async () => {
    session(null);
    renderAt("/home");
    expect(await screen.findByText("sign-in page /home")).toBeInTheDocument();
  });

  it("gives Home the shared lists", async () => {
    vi.mocked(loadDestinations).mockResolvedValue([DEST]);
    renderAt("/home");
    expect(await screen.findByText("home page 0 connections, 1 destinations")).toBeInTheDocument();
  });

  it.each([
    ["/check-email", "check-email page"],
    ["/reset-password", "reset page"],
    ["/set-password", "set-password page"],
  ])("serves %s to anyone", async (path, text) => {
    session(null);
    renderAt(path);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("serves Stats publicly in the app shell, with the account sections disabled", async () => {
    session(null);
    renderAt("/stats");
    expect(await screen.findByText("stats page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connections" })).toHaveAttribute("aria-disabled", "true");
  });

  it("serves Stats inside the app shell when signed in", async () => {
    renderAt("/stats");
    expect(await screen.findByText("stats page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("serves Health publicly, and inside the app shell when signed in", async () => {
    session(null);
    const { unmount } = renderAt("/health");
    expect(await screen.findByText("health page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Health" })).toHaveClass("Mui-selected");
    unmount();
    session(SESSION);
    renderAt("/health");
    expect(await screen.findByText("health page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("serves lookup publicly", async () => {
    session(null);
    renderAt("/lookup");
    expect(await screen.findByText("lookup page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("serves a signed-out profile in UTC with no account", async () => {
    session(null);
    renderAt("/call/KK4PWJ/P");
    expect(await screen.findByText("callsign page UTC signed out")).toBeInTheDocument();
  });

  it("serves Reference lookup signed out, and inside the app when signed in", async () => {
    session(null);
    const { unmount } = renderAt("/ref");
    expect(await screen.findByText("reference lookup page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reference lookup" })).toHaveClass("Mui-selected");
    unmount();
    session(SESSION);
    renderAt("/ref");
    expect(await screen.findByText("reference lookup page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("serves a reference page signed out, and signed in with its alerts", async () => {
    session(null);
    const { unmount } = renderAt("/ref/sota/W4C/CM-001");
    expect(await screen.findByText("reference page sota W4C/CM-001 signed out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    unmount();
    session(SESSION);
    renderAt("/ref/pota/US-2763");
    expect(await screen.findByText("reference page pota US-2763 signed in")).toBeInTheDocument();
  });

  it("serves a public group page signed out, and inside the app when signed in", async () => {
    session(null);
    const { unmount } = renderAt("/g/7f3kq6xm2a");
    expect(await screen.findByText("public group page 7f3kq6xm2a")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    unmount();
    session(SESSION);
    renderAt("/g/7f3kq6xm2a");
    expect(await screen.findByText("public group page 7f3kq6xm2a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("serves lookup and profiles inside the app shell when signed in", async () => {
    renderAt("/call/KK4PWJ");
    expect(await screen.findByText("callsign page Asia/Tokyo signed in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Callsign lookup" })).toHaveClass("Mui-selected");
  });

  it("serves the lookup page inside the app shell when signed in", async () => {
    renderAt("/lookup");
    expect(await screen.findByText("lookup page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("waits for the profile before rendering a signed-in page", async () => {
    vi.mocked(loadProfile).mockReturnValue(new Promise(() => {}));
    renderAt("/account");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText("account page")).not.toBeInTheDocument();
  });

  it("offers Retry when the profile fails to load, and recovers", async () => {
    vi.mocked(loadProfile).mockRejectedValueOnce(new Error("Couldn't load your profile."));
    renderAt("/account");
    expect(await screen.findByText("Couldn't load your profile.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("account page")).toBeInTheDocument();
    expect(loadProfile).toHaveBeenCalledTimes(2);
  });

  it("offers Sign out when the profile fails to load", async () => {
    vi.mocked(loadProfile).mockRejectedValue(new Error("Couldn't load your profile."));
    renderAt("/account");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledWith("local", pushCleanup);
  });

  it("says so when signing out from the profile error fails", async () => {
    vi.mocked(loadProfile).mockRejectedValue(new Error("Couldn't load your profile."));
    vi.mocked(signOut).mockRejectedValue(new Error("x"));
    renderAt("/account");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Couldn't sign out. Try again.")).toBeInTheDocument();
  });

  it("loads destinations and connections for the signed-in pages", async () => {
    renderAt("/destinations");
    expect(await screen.findByText("destinations page Shack")).toBeInTheDocument();
  });

  it.each([
    ["/connections", "subscriptions page 0"],
    ["/connections/new?source=pota", "subscription editor new pota any"],
    ["/connections/new?source=rbn&callsign=KK4PWJ", "subscription editor new rbn KK4PWJ"],
    ["/connections/new?source=pota&group=g1", "subscription editor new pota any group g1"],
    ["/connections/new?source=sotawatch&reference=W4C%2FCM-001", "subscription editor new sotawatch any reference W4C/CM-001"],
    ["/connections/s1", "subscription editor s1 none any"],
    // Old bookmarks redirect, keeping the id and query string.
    ["/subscriptions", "subscriptions page 0"],
    ["/subscriptions/new?source=rbn&callsign=KK4PWJ", "subscription editor new rbn KK4PWJ"],
    ["/subscriptions/s1", "subscription editor s1 none any"],
    ["/groups", "groups page"],
    ["/groups/g1", "group page g1 statistics"],
    ["/groups/g1/settings", "group page g1 settings"],
    ["/account", "account page"],
  ])("renders %s", async (path, text) => {
    renderAt(path);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each([
    ["/destinations/new?type=discord", "discord editor new discord"],
    ["/destinations/new?type=push", "push editor new push"],
    ["/destinations/new?type=webhook", "webhook editor new webhook"],
    ["/destinations/dc", "discord editor dc none"],
    ["/destinations/dw", "webhook editor dw none"],
    ["/destinations/dp", "push editor dp none"],
    ["/destinations/new?type=local_cluster", "cluster editor new local_cluster"],
    ["/destinations/dl", "cluster editor dl none"],
  ])("routes %s to the editor for its type", async (path, text) => {
    vi.mocked(loadDestinations).mockResolvedValue([
      DEST, { ...DEST, id: "dc", type: "discord" }, { ...DEST, id: "dp", type: "push" }, { ...DEST, id: "dw", type: "webhook" },
      { ...DEST, id: "dl", type: "local_cluster" },
    ]);
    renderAt(path);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each(["/destinations/new", "/destinations/new?type=email", "/destinations/missing"])(
    "sends %s back to the list",
    async (path) => {
      vi.mocked(loadDestinations).mockResolvedValue([{ ...DEST, id: "dw", type: "webhook" }]);
      renderAt(path);
      expect(await screen.findByText("destinations page Shack")).toBeInTheDocument();
    },
  );

  it("waits for the destinations before routing an id", async () => {
    vi.mocked(loadDestinations).mockReturnValue(new Promise(() => {}));
    renderAt("/destinations/dc");
    // The shell is up (the profile loaded), and the route shows progress instead of guessing a type.
    expect((await screen.findAllByText("Destinations")).length).toBeGreaterThan(0);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText(/editor/)).not.toBeInTheDocument();
  });

  it("toasts when shared data fails to load", async () => {
    vi.mocked(loadDestinations).mockRejectedValue(new Error("x"));
    renderAt("/sources");
    expect(await screen.findByText("Couldn't load your destinations and connections.")).toBeInTheDocument();
    expect(screen.getByText("sources page")).toBeInTheDocument();
  });

  it.each(["/home", "/destinations", "/destinations/dc", "/connections", "/connections/s1"])(
    "shows a failed load on %s with Retry instead of an empty list or a redirect, and recovers",
    async (path) => {
      vi.mocked(loadDestinations).mockRejectedValueOnce(new Error("x")).mockResolvedValue([{ ...DEST, id: "dc", type: "discord" }]);
      renderAt(path);
      const retry = await screen.findByRole("button", { name: "Retry" });
      expect(screen.queryByText(/page|editor/)).not.toBeInTheDocument();
      await userEvent.click(retry);
      expect(await screen.findByText(/page|editor/)).toBeInTheDocument();
      expect(loadDestinations).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the lists it has when a later reload fails", async () => {
    vi.mocked(loadDestinations).mockResolvedValueOnce([DEST]).mockRejectedValue(new Error("x"));
    renderAt("/destinations");
    expect(await screen.findByText("destinations page Shack")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(await screen.findByText("Couldn't load your destinations and connections.")).toBeInTheDocument();
    expect(screen.getByText("destinations page Shack")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("marks Destinations in the nav when one is failing", async () => {
    vi.mocked(loadDestinations).mockResolvedValue([{ ...DEST, health: "failing" }]);
    const { container } = renderAt("/sources");
    await screen.findByText("sources page");
    await waitFor(() => expect(container.querySelector(".MuiBadge-dot:not(.MuiBadge-invisible)")).not.toBeNull());
  });
});
