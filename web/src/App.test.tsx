import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { Session } from "@supabase/supabase-js";
import App from "./App";
import { useSession } from "./auth/useSession";
import { loadDestinations, loadProfile, loadSubscriptions, signOut, type Destination } from "./lib/api";
import { PROFILE, SESSION } from "./test/render";

vi.mock("./auth/useSession", () => ({ useSession: vi.fn() }));
vi.mock("./lib/api", () => ({ loadProfile: vi.fn(), loadDestinations: vi.fn(), loadSubscriptions: vi.fn(), signOut: vi.fn() }));
vi.mock("@vercel/speed-insights/react", () => ({ SpeedInsights: () => null }));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));

// App's job is routing and loading shared data; each page has its own tests.
// The stubs show which page rendered and the props App passed it.
vi.mock("./auth/SignInPage", () => ({ SignInPage: () => <p>sign-in page</p> }));
vi.mock("./auth/CheckEmailPage", () => ({ CheckEmailPage: () => <p>check-email page</p> }));
vi.mock("./auth/ResetPasswordPage", () => ({ ResetPasswordPage: () => <p>reset page</p> }));
vi.mock("./auth/SetPasswordPage", () => ({ SetPasswordPage: () => <p>set-password page</p> }));
vi.mock("./sources/SourcesPage", () => ({
  SourcesPage: () => <p>sources page</p>,
}));
vi.mock("./sources/SourceDetailPage", () => ({
  SourceDetailPage: ({ prefs }: { prefs: { timezone: string } }) => <p>source page {prefs.timezone}</p>,
}));
vi.mock("./destinations/DestinationsPage", () => ({
  DestinationsPage: ({ dests, loading }: { dests: Destination[]; loading: boolean }) => (
    <p>destinations page {loading ? "loading" : dests.map((d) => d.name).join(",")}</p>
  ),
}));
vi.mock("./subscriptions/SubscriptionsPage", () => ({
  SubscriptionsPage: ({ subs }: { subs: unknown[] }) => <p>subscriptions page {subs.length}</p>,
}));
vi.mock("./subscriptions/SubscriptionEditorPage", () => ({
  SubscriptionEditorPage: ({ id, source, callsign }: { id?: string; source?: string | null; callsign?: string | null }) => (
    <p>subscription editor {id ?? "new"} {source ?? "none"} {callsign ?? "any"}</p>
  ),
}));
vi.mock("./groups/GroupsPage", () => ({ GroupsPage: () => <p>groups page</p> }));
vi.mock("./stats/StatsPage", () => ({ StatsPage: () => <p>stats page</p> }));
vi.mock("./account/AccountPage", () => ({ AccountPage: () => <p>account page</p> }));
vi.mock("./profile/LookupPage", () => ({ LookupPage: () => <p>lookup page</p> }));
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

describe("App routing", () => {
  it("sends signed-out visitors to sign in", async () => {
    session(null);
    renderAt("/destinations");
    expect(await screen.findByText("sign-in page")).toBeInTheDocument();
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

  it("sends signed-in users from sign in to Sources", async () => {
    renderAt("/signin");
    expect(await screen.findByText("sources page")).toBeInTheDocument();
  });

  it("redirects unknown paths to Sources", async () => {
    renderAt("/nope");
    expect(await screen.findByText("sources page")).toBeInTheDocument();
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

  it("serves Stats publicly without the app shell", async () => {
    session(null);
    renderAt("/stats");
    expect(await screen.findByText("stats page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("serves Stats inside the app shell when signed in", async () => {
    renderAt("/stats");
    expect(await screen.findByText("stats page")).toBeInTheDocument();
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
    expect(signOut).toHaveBeenCalledWith();
  });

  it("says so when signing out from the profile error fails", async () => {
    vi.mocked(loadProfile).mockRejectedValue(new Error("Couldn't load your profile."));
    vi.mocked(signOut).mockRejectedValue(new Error("x"));
    renderAt("/account");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Couldn't sign out. Try again.")).toBeInTheDocument();
  });

  it("loads destinations and subscriptions for the signed-in pages", async () => {
    renderAt("/destinations");
    expect(await screen.findByText("destinations page Shack")).toBeInTheDocument();
  });

  it.each([
    ["/subscriptions", "subscriptions page 0"],
    ["/subscriptions/new?source=pota", "subscription editor new pota any"],
    ["/subscriptions/new?source=rbn&callsign=KK4PWJ", "subscription editor new rbn KK4PWJ"],
    ["/subscriptions/s1", "subscription editor s1 none any"],
    ["/groups", "groups page"],
    ["/account", "account page"],
  ])("renders %s", async (path, text) => {
    renderAt(path);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("toasts when shared data fails to load", async () => {
    vi.mocked(loadDestinations).mockRejectedValue(new Error("x"));
    renderAt("/destinations");
    expect(await screen.findByText("Couldn't load your destinations and subscriptions.")).toBeInTheDocument();
  });

  it("marks Destinations in the nav when one is failing", async () => {
    vi.mocked(loadDestinations).mockResolvedValue([{ ...DEST, health: "failing" }]);
    const { container } = renderAt("/sources");
    await screen.findByText("sources page");
    await waitFor(() => expect(container.querySelector(".MuiBadge-dot:not(.MuiBadge-invisible)")).not.toBeNull());
  });
});
