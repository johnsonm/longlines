import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiError, loadDestinations, loadSubscriptions, saveSubscription, type Destination, type SubscriptionWithLinks } from "../lib/api";
import { appValue, wrap } from "../test/render";
import { LocationProbe } from "../test/LocationProbe";
import { setMobile } from "../test/media";
import type { AppContextValue } from "../app/context";
import { CallsignPage, Footer, type AlertAccount } from "./CallsignPage";
import { FULL, HEARD, NOT_HEARD } from "./fixtures";
import type { CallsignProfile } from "./types";
import { useCallsignProfile } from "./useCallsignProfile";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    code: string | undefined;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
  saveSubscription: vi.fn(),
  loadDestinations: vi.fn(),
  loadSubscriptions: vi.fn(),
}));
vi.mock("./useCallsignProfile", () => ({ useCallsignProfile: vi.fn() }));

const UTC = { utcTimes: true, timezone: "UTC" };
const DEST = { id: "d1", name: "Shack", health: "ok" } as Destination;

function profileIs(profile: CallsignProfile | null, error: unknown = null) {
  vi.mocked(useCallsignProfile).mockReturnValue({ profile, error, loading: !profile && !error });
}

function renderAt(path: string, options: { account?: AlertAccount; app?: Partial<AppContextValue> } = {}) {
  const app = appValue(options.app);
  const user = userEvent.setup({ delay: null });
  render(
    wrap(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/call/*" element={<CallsignPage prefs={UTC} account={options.account} />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
      app,
    ),
  );
  return { app, user, where: () => screen.getByTestId("location") };
}

beforeEach(() => {
  vi.mocked(useCallsignProfile).mockReset();
  vi.mocked(saveSubscription).mockReset().mockResolvedValue("s1");
  vi.mocked(loadDestinations).mockReset().mockResolvedValue([DEST]);
  vi.mocked(loadSubscriptions).mockReset().mockResolvedValue([]);
  profileIs(FULL);
});

describe("CallsignPage URL", () => {
  it("redirects a lowercase callsign to the uppercase URL", async () => {
    const { where } = renderAt("/call/kk4pwj");
    await waitFor(() => expect(where()).toHaveTextContent("/call/KK4PWJ"));
    expect(vi.mocked(useCallsignProfile)).toHaveBeenCalledWith("KK4PWJ");
    expect(vi.mocked(useCallsignProfile)).not.toHaveBeenCalledWith("kk4pwj");
  });

  it("drops stray slashes and sends an empty callsign to lookup", async () => {
    const first = renderAt("/call/KK4PWJ/");
    await waitFor(() => expect(first.where()).toHaveTextContent(/^\/call\/KK4PWJ$/));
  });

  it("sends a bare /call/ to lookup", async () => {
    const { where } = renderAt("/call/");
    await waitFor(() => expect(where()).toHaveTextContent("/lookup"));
  });

  it("swaps a portable callsign for the base call the profile returns", async () => {
    const { where } = renderAt("/call/KK4PWJ/P");
    expect(vi.mocked(useCallsignProfile)).toHaveBeenCalledWith("KK4PWJ/P");
    await waitFor(() => expect(where()).toHaveTextContent(/^\/call\/KK4PWJ$/));
  });
});

describe("CallsignPage states", () => {
  it("shows progress while loading", () => {
    profileIs(null);
    renderAt("/call/KK4PWJ");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("warns about an invalid callsign and offers a search box", async () => {
    profileIs(null, new ApiError("Enter a callsign, like KK4PWJ.", "400"));
    const { user, where } = renderAt("/call/BOGUS");
    expect(screen.getByText("BOGUS isn't a valid callsign. Enter a callsign, like KK4PWJ.")).toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: "Callsign" });
    expect(box).toHaveValue("BOGUS");
    await user.clear(box);
    await user.type(box, "w1aw{Enter}");
    expect(where()).toHaveTextContent("/call/W1AW");
  });

  it("shows other errors as they come", () => {
    profileIs(null, new ApiError("Too many lookups. Try again in a minute.", "429"));
    renderAt("/call/KK4PWJ");
    expect(screen.getByText("Too many lookups. Try again in a minute.")).toBeInTheDocument();
  });

  it("shows a not-heard call with the header, license card and a quiet message, and no charts", () => {
    profileIs(NOT_HEARD);
    renderAt("/call/G4ABC");
    expect(screen.getByRole("heading", { name: "G4ABC" })).toBeInTheDocument();
    expect(screen.getByText("England")).toBeInTheDocument();
    expect(screen.getByText("No FCC record. This looks like a callsign issued outside the United States.")).toBeInTheDocument();
    expect(screen.getByText("Long Lines hasn't heard G4ABC on the air yet.")).toBeInTheDocument();
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last heard/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("says no FCC record found for a US prefix", () => {
    profileIs({ ...NOT_HEARD, callsign: "W1QRP", usPrefix: true, country: { name: "United States", continent: "NA" } });
    renderAt("/call/W1QRP");
    expect(screen.getByText("No FCC record found for this callsign.")).toBeInTheDocument();
  });

  it("treats a station that only spotted others as not heard, showing its hunting", () => {
    profileIs({ ...NOT_HEARD, heard: { ...HEARD, spots: 0, firstHeard: null, lastHeard: null } });
    renderAt("/call/G4ABC");
    expect(screen.getByText("Long Lines hasn't heard G4ABC on the air yet.")).toBeInTheDocument();
    expect(screen.getByText("Hunting")).toBeInTheDocument();
    expect(screen.getByText("40 POTA, 2 SOTAwatch")).toBeInTheDocument();
  });
});

describe("CallsignPage profile", () => {
  it("renders the header, KPIs and license", () => {
    renderAt("/call/KK4PWJ");
    expect(screen.getByRole("heading", { name: "KK4PWJ" })).toBeInTheDocument();
    expect(screen.getAllByText("Alex R Example").length).toBe(2);
    expect(screen.getAllByText("Amateur Extra").length).toBe(2);
    expect(screen.getByText("North Carolina")).toBeInTheDocument();
    expect(screen.getByText(/^Last heard 14:32 UTC .* on 14\.062 MHz CW$/)).toBeInTheDocument();
    expect(screen.getByText("Also heard as KK4PWJ/P")).toBeInTheDocument();
    expect(screen.getByText(`${window.location.origin}/call/KK4PWJ`)).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("All time")).toBeInTheDocument();
    expect(screen.getByText("Since Oct 5, 2026")).toBeInTheDocument();
    expect(screen.getByText("12 countries")).toBeInTheDocument();
    expect(screen.getByText("3 continents")).toBeInTheDocument();
    expect(screen.getByText("3 parks, 2 summits")).toBeInTheDocument();
    expect(screen.getByText("From the FCC Universal Licensing System. Refreshed weekly.")).toBeInTheDocument();
    expect(screen.getByText("Mar 1, 2036")).toBeInTheDocument();
    expect(screen.getByText("NC")).toBeInTheDocument();
  });

  it("renders every section", () => {
    renderAt("/call/KK4PWJ");
    for (const title of [
      "Activity", "Last 30 days", "When they're on the air", "Bands", "Modes", "Where they've activated", "Hunting", "Heard by",
      "Recent spots",
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    // The KPI and the card share the name.
    expect(screen.getAllByText("Heard from")).toHaveLength(2);
    expect(screen.getByText("Spots per month, since Long Lines started")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Map of activations by state" })).toBeInTheDocument();
    expect(screen.getByText("Pisgah National Forest")).toBeInTheDocument();
    expect(screen.getByText("Germany")).toBeInTheDocument();
    expect(screen.getByText("W3LPL")).toBeInTheDocument();
    expect(screen.getByText("31 dB")).toBeInTheDocument();
    expect(screen.getByText("N4XYZ")).toBeInTheDocument();
    expect(screen.getByText(/License data comes from the public FCC database\. Long Lines never shows street addresses\./))
      .toBeInTheDocument();
  });

  it("hides the map with only non-US activations and sections with nothing to show", () => {
    profileIs({
      ...FULL,
      heard: { ...HEARD, activationsByLocation: {}, reach: [], hunting: { spots: 0, sources: [] }, heardBy: [], recentSpots: [] },
    });
    renderAt("/call/KK4PWJ");
    expect(screen.getByText("Where they've activated")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Map of activations by state" })).not.toBeInTheDocument();
    for (const title of ["Hunting", "Heard by", "Recent spots"]) expect(screen.queryByText(title)).not.toBeInTheDocument();
    expect(screen.getAllByText("Heard from")).toHaveLength(1);
  });

  it("hides the activations card when there are none", () => {
    profileIs({ ...FULL, heard: { ...HEARD, references: [], activations: [], activationsByLocation: {} } });
    renderAt("/call/KK4PWJ");
    expect(screen.queryByText("Where they've activated")).not.toBeInTheDocument();
    expect(screen.getByText("0 parks, 0 summits")).toBeInTheDocument();
  });

  it("renders on phones", () => {
    setMobile(true);
    renderAt("/call/KK4PWJ");
    expect(screen.getByText("Recent spots")).toBeInTheDocument();
  });
});

describe("Share", () => {
  it("uses the native share sheet when there is one", async () => {
    const share = vi.fn(() => Promise.reject(new DOMException("cancel", "AbortError")));
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      const { user, app } = renderAt("/call/KK4PWJ");
      await user.click(screen.getByRole("button", { name: "Share" }));
      expect(share).toHaveBeenCalledWith({ title: "KK4PWJ on Long Lines", url: `${window.location.origin}/call/KK4PWJ` });
      expect(app.notify).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("falls back to copying the link when the share sheet fails for another reason", async () => {
    const share = vi.fn(() => Promise.reject(new DOMException("not allowed", "NotAllowedError")));
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      const { user, app } = renderAt("/call/KK4PWJ");
      const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce(undefined);
      await user.click(screen.getByRole("button", { name: "Share" }));
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/call/KK4PWJ`);
      await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Link copied."));
    } finally {
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("does nothing more once the share sheet succeeds", async () => {
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      const { user, app } = renderAt("/call/KK4PWJ");
      await user.click(screen.getByRole("button", { name: "Share" }));
      expect(share).toHaveBeenCalled();
      expect(app.notify).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("copies the link otherwise, and says when it can't", async () => {
    const { user, app } = renderAt("/call/KK4PWJ");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/call/KK4PWJ`);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Link copied."));
    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't copy the link."));
  });
});

const account = () => ({ reload: vi.fn(() => Promise.resolve()) });

describe("Get alerts", () => {
  it("sends a signed-out visitor to sign in and back", async () => {
    const { user, where } = renderAt("/call/KK4PWJ");
    await user.click(screen.getByRole("button", { name: "Sign in to get alerts" }));
    expect(where()).toHaveTextContent("/signin");
    expect(JSON.parse(where().dataset.state ?? "null")).toEqual({ from: "/call/KK4PWJ" });
  });

  it("creates the subscription to the first healthy destination and opens Subscriptions", async () => {
    vi.mocked(loadDestinations).mockResolvedValue([{ ...DEST, id: "bad", health: "failing" }, DEST]);
    const alerts = account();
    const { user, app, where } = renderAt("/call/KK4PWJ", { account: alerts });
    await user.click(screen.getByRole("button", { name: "Get alerts" }));
    await waitFor(() => expect(where()).toHaveTextContent("/subscriptions"));
    expect(saveSubscription).toHaveBeenCalledWith({
      name: "KK4PWJ on the air", enabled: true, quiet_minutes: 30, destinations: ["d1"],
      sources: [], rules: [[{ field: "callsign", op: "is", values: ["KK4PWJ"] }]],
    });
    expect(alerts.reload).toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith("Created KK4PWJ on the air");
  });

  it("opens Subscriptions instead of creating a second subscription for the same call", async () => {
    vi.mocked(loadSubscriptions).mockResolvedValue([
      { id: "s9", name: "Pisgah regulars", rules: [[{ field: "callsign", op: "is", values: ["W1AW", "KK4PWJ"] }]] } as unknown as SubscriptionWithLinks,
    ]);
    const { user, app, where } = renderAt("/call/KK4PWJ", { account: account() });
    await user.click(screen.getByRole("button", { name: "Get alerts" }));
    await waitFor(() => expect(where()).toHaveTextContent("/subscriptions"));
    expect(app.notify).toHaveBeenCalledWith("You already have Pisgah regulars.");
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it("does not count a subscription to a portable form as covering the base call", async () => {
    vi.mocked(loadSubscriptions).mockResolvedValue([
      { id: "s9", name: "Portable", rules: [[{ field: "callsign", op: "is", values: ["KK4PWJ/P"] }]] } as unknown as SubscriptionWithLinks,
    ]);
    const { user } = renderAt("/call/KK4PWJ", { account: account() });
    await user.click(screen.getByRole("button", { name: "Get alerts" }));
    await waitFor(() => expect(saveSubscription).toHaveBeenCalled());
  });

  it.each([
    ["no destinations", []],
    ["only paused or failing ones", [{ ...DEST, health: "paused" }, { ...DEST, id: "d2", health: "failing" }]],
  ])("sends a user with %s to add one", async (_label, dests) => {
    vi.mocked(loadDestinations).mockResolvedValue(dests as Destination[]);
    const { user, app, where } = renderAt("/call/KK4PWJ", { account: account() });
    await user.click(screen.getByRole("button", { name: "Get alerts" }));
    await waitFor(() => expect(where()).toHaveTextContent("/destinations"));
    expect(app.notify).toHaveBeenCalledWith("Add a destination to start getting alerts.");
    expect(saveSubscription).not.toHaveBeenCalled();
  });

  it("reads destinations at the click, not from a list that may not have loaded", async () => {
    const { user } = renderAt("/call/KK4PWJ", { account: account() });
    expect(loadDestinations).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Get alerts" }));
    await waitFor(() => expect(saveSubscription).toHaveBeenCalled());
    expect(loadDestinations).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save and stays on the profile", async () => {
    vi.mocked(saveSubscription).mockRejectedValue(new Error("Destination not found."));
    const { user, app, where } = renderAt("/call/KK4PWJ", { account: account() });
    await user.click(screen.getByRole("button", { name: "Get alerts" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Destination not found."));
    expect(where()).toHaveTextContent("/call/KK4PWJ");
    expect(screen.getByRole("button", { name: "Get alerts" })).toBeEnabled();
  });

  it("reports a failed destination load", async () => {
    vi.mocked(loadDestinations).mockRejectedValue(new Error("Couldn't load destinations."));
    const { user, app } = renderAt("/call/KK4PWJ", { account: account() });
    await user.click(screen.getByRole("button", { name: "Get alerts" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't load destinations."));
    expect(saveSubscription).not.toHaveBeenCalled();
  });
});

describe("Footer", () => {
  it("adds the contact address when one is configured", () => {
    render(<Footer email="hide@example.com" />);
    const link = screen.getByRole("link", { name: "hide@example.com" });
    expect(link).toHaveAttribute("href", "mailto:hide@example.com");
    expect(link.parentElement).toHaveTextContent(
      "License data comes from the public FCC database. Long Lines never shows street addresses. To have this page hidden, email hide@example.com.",
    );
  });

  it("leaves the sentence out without one", () => {
    render(<Footer email="" />);
    expect(screen.queryByText(/To have this page hidden/)).not.toBeInTheDocument();
    expect(within(document.body).queryByRole("link")).not.toBeInTheDocument();
  });
});
