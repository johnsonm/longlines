import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiError } from "../lib/api";
import { appValue, wrap } from "../test/render";
import { LocationProbe } from "../test/LocationProbe";
import { setMobile } from "../test/media";
import type { AppContextValue } from "../app/context";
import { CallsignPage, Footer } from "./CallsignPage";
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
}));
// The source picker shows rates from the stats snapshot; none are needed here.
vi.mock("../stats/useStats", () => ({ useStats: () => ({ stats: null, loading: false, error: null }) }));
vi.mock("./useCallsignProfile", () => ({ useCallsignProfile: vi.fn() }));
// The tab's own request and rendering are ActivationsTab.test.tsx's.
vi.mock("../activations/ActivationsTab", () => ({
  ActivationsTab: ({ callsign }: { callsign: string }) => <div data-testid="activations-tab">{callsign}</div>,
}));

const UTC = { utcTimes: true, timezone: "UTC" };

function profileIs(profile: CallsignProfile | null, error: unknown = null) {
  vi.mocked(useCallsignProfile).mockReturnValue({ profile, error, loading: !profile && !error });
}

function renderAt(path: string, options: { signedIn?: boolean; app?: Partial<AppContextValue> } = {}) {
  const app = appValue(options.app);
  const user = userEvent.setup({ delay: null });
  render(
    wrap(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/call/*" element={<CallsignPage prefs={UTC} signedIn={options.signedIn} />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
      app,
    ),
  );
  return { app, user, where: () => screen.getByTestId("location") };
}

/** The header card, so its chips don't collide with chart labels. */
function header() {
  return within(screen.getByRole("heading", { name: "KK4PWJ" }).closest<HTMLElement>(".MuiCard-root")!);
}

beforeEach(() => {
  vi.mocked(useCallsignProfile).mockReset();
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
    expect(screen.getByRole("img", { name: "England" })).toHaveAttribute("src", expect.stringMatching(/gb-eng\.svg$/));
    expect(screen.getByText("No FCC record. This looks like a callsign issued outside the United States.")).toBeInTheDocument();
    expect(screen.getByText("Long Lines hasn't heard G4ABC on the air yet.")).toBeInTheDocument();
    expect(screen.queryByText("Spots per month, since Long Lines started")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last heard/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("shows no flag for a call cty.dat places nowhere", () => {
    profileIs({ ...NOT_HEARD, callsign: "1A0KM", country: null });
    renderAt("/call/1A0KM");
    expect(screen.getByRole("heading", { name: "1A0KM" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
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
    expect(screen.getByText("Last heard")).toBeInTheDocument();
    expect(screen.getByText("14062.0 kHz")).toBeInTheDocument();
    expect(header().getByText("CW")).toBeInTheDocument();
    expect(screen.getByText(/^Oct 12(, 2026)? \(14:32 UTC\)$/)).toBeInTheDocument();
    expect(screen.getByText("Activating US-0817, Pisgah National Forest. Spotted by N4XYZ.")).toBeInTheDocument();
    expect(screen.queryByText("On the air now")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "QRZ" })).toHaveAttribute("href", "https://www.qrz.com/db/KK4PWJ");
    expect(screen.getByText("Also heard as KK4PWJ/P")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "United States" })).toHaveAttribute("src", expect.stringMatching(/us\.svg$/));
    expect(screen.queryByText(`${window.location.origin}/call/KK4PWJ`)).not.toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("All time")).toBeInTheDocument();
    expect(screen.getByText("Since Oct 5, 2026")).toBeInTheDocument();
    expect(screen.getByText("12 countries")).toBeInTheDocument();
    expect(screen.getByText("3 continents")).toBeInTheDocument();
    expect(screen.getByText("3 parks, 2 summits, 1 WWFF reference")).toBeInTheDocument();
    expect(screen.getByText("From the FCC Universal Licensing System. Refreshed weekly.")).toBeInTheDocument();
    expect(screen.getByText("Mar 1, 2036")).toBeInTheDocument();
    expect(screen.getByText("NC")).toBeInTheDocument();
  });

  it("says a station spotted in the last half hour is on the air now", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-12T14:34:00Z"));
    try {
      renderAt("/call/KK4PWJ");
      expect(screen.getByText("On the air now")).toBeInTheDocument();
      expect(screen.getByText("2 min ago (14:32 UTC)")).toBeInTheDocument();
      expect(header().getByText("20m")).toBeInTheDocument();
      expect(header().getByText("POTA")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the year heat map after the figures", () => {
    renderAt("/call/KK4PWJ");
    expect(screen.getByRole("img", { name: /^Heat map of spots heard per day/ })).toBeInTheDocument();
    expect(screen.getByText("Activity over the past year")).toBeInTheDocument();
  });

  it("leaves the heat map out of a profile cached before it existed", () => {
    profileIs({ ...FULL, heard: { ...HEARD, calendar: undefined } });
    renderAt("/call/KK4PWJ");
    expect(screen.queryByText("Activity over the past year")).not.toBeInTheDocument();
  });

  it("shows only the frequency and mode when the last spot is older than the recent spots", () => {
    profileIs({ ...FULL, heard: { ...HEARD, recentSpots: [] } });
    renderAt("/call/KK4PWJ");
    expect(screen.getByText("14062.0 kHz")).toBeInTheDocument();
    expect(screen.queryByText(/^Activating/)).not.toBeInTheDocument();
    expect(header().queryByText("20m")).not.toBeInTheDocument();
    expect(header().getByText("CW")).toBeInTheDocument();
  });

  it("renders every section", () => {
    renderAt("/call/KK4PWJ");
    for (const title of [
      "Last 30 days", "When they're on the air", "Bands", "Modes", "Where they've been spotted", "Hunting", "Heard by",
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    // The KPI and the card share the name.
    expect(screen.getAllByText("Heard from")).toHaveLength(2);
    expect(screen.getByText("Countries of the spotters and skimmers who heard this station. Self-spots don't count.")).toBeInTheDocument();
    expect(screen.getByText("Spots per month, since Long Lines started")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Map of visits by state" })).toBeInTheDocument();
    expect(screen.getByText("Pisgah National Forest")).toBeInTheDocument();
    expect(screen.getByText("T.M. Goodwin")).toBeInTheDocument();
    // Each reference links to its page; SOTA's "/" stays a path separator.
    expect(screen.getByRole("link", { name: "US-0817" })).toHaveAttribute("href", "/ref/pota/US-0817");
    expect(screen.getByRole("link", { name: "W4C/CM-001" })).toHaveAttribute("href", "/ref/sota/W4C/CM-001");
    expect(screen.getByRole("link", { name: "KFF-5268" })).toHaveAttribute("href", "/ref/wwff/KFF-5268");
    expect(screen.getByText("Germany")).toBeInTheDocument();
    expect(screen.getByText("W3LPL")).toBeInTheDocument();
    expect(screen.getByText("31 dB")).toBeInTheDocument();
    // The recent spots are the Spots tab's.
    expect(screen.queryByText("Recent spots")).not.toBeInTheDocument();
    expect(screen.getByText(/License data comes from the public FCC database\. Long Lines never shows street addresses\./))
      .toBeInTheDocument();
  });

  it("hides the map with only non-US activations and sections with nothing to show", () => {
    profileIs({
      ...FULL,
      heard: { ...HEARD, activationsByLocation: {}, reach: [], hunting: { spots: 0, sources: [] }, heardBy: [], recentSpots: [] },
    });
    renderAt("/call/KK4PWJ");
    expect(screen.getByText("Where they've been spotted")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Map of visits by state" })).not.toBeInTheDocument();
    for (const title of ["Hunting", "Heard by", "Recent spots"]) expect(screen.queryByText(title)).not.toBeInTheDocument();
    expect(screen.getAllByText("Heard from")).toHaveLength(1);
  });

  it("lists only the ten most recent parks and summits, as visits", () => {
    const references = Array.from({ length: 12 }, (_, i) => ({
      reference: `US-${1000 + i}`, name: `Park ${i}`, program: "POTA", location: "US-NC", activations: 1, spots: 4, lastDay: "2026-10-12",
    }));
    profileIs({ ...FULL, heard: { ...HEARD, references } });
    renderAt("/call/KK4PWJ");
    expect(screen.getByText("Park/summit/WWFF visits")).toBeInTheDocument();
    expect(screen.getByText("Parks, summits, WWFF references, bunkers and islands, most recent first. A visit is one reference on one UTC day.")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Visits" })).toBeInTheDocument();
    expect(screen.getByText("US-1009")).toBeInTheDocument();
    expect(screen.queryByText("US-1010")).not.toBeInTheDocument();
  });

  it("hides the activations card when there are none", () => {
    profileIs({ ...FULL, heard: { ...HEARD, references: [], activations: [], activationsByLocation: {} } });
    renderAt("/call/KK4PWJ");
    expect(screen.queryByText("Where they've been spotted")).not.toBeInTheDocument();
    expect(screen.getByText("0 parks, 0 summits, 0 WWFF references")).toBeInTheDocument();
  });

  it("renders on phones", () => {
    setMobile(true);
    renderAt("/call/KK4PWJ?tab=spots");
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

describe("Get alerts", () => {
  it("sends a signed-out visitor to sign in and back", async () => {
    const { user, where } = renderAt("/call/KK4PWJ");
    await user.click(screen.getByRole("button", { name: "Sign in to get alerts" }));
    expect(where()).toHaveTextContent("/signin");
    expect(JSON.parse(where().dataset.state ?? "null")).toEqual({ from: "/call/KK4PWJ" });
  });

  it("asks for a source, then opens the editor on it with the callsign as the filter", async () => {
    const { user, where } = renderAt("/call/KK4PWJ", { signedIn: true });
    await user.click(screen.getByRole("button", { name: "Get alerts for KK4PWJ" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.click(dialog.getByRole("radio", { name: /Reverse Beacon Network/ }));
    await user.click(dialog.getByRole("button", { name: "Continue" }));
    expect(where()).toHaveTextContent(/^\/connections\/new$/);
    expect(where().dataset.search).toBe("?source=rbn&callsign=KK4PWJ");
  });

  it("stays on the profile when the picker is cancelled", async () => {
    const { user, where } = renderAt("/call/KK4PWJ", { signedIn: true });
    await user.click(screen.getByRole("button", { name: "Get alerts for KK4PWJ" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(where()).toHaveTextContent("/call/KK4PWJ");
  });
});

describe("CallsignPage tabs", () => {
  it("opens on Activity, with links to the other two tabs", () => {
    renderAt("/call/KK4PWJ");
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("href", "/call/KK4PWJ");
    expect(screen.getByRole("tab", { name: "Spotted activations" })).toHaveAttribute("href", "/call/KK4PWJ?tab=activations");
    expect(screen.getByRole("tab", { name: "Spots" })).toHaveAttribute("href", "/call/KK4PWJ?tab=spots");
    expect(screen.getByText("Spots per month, since Long Lines started")).toBeInTheDocument();
    expect(screen.queryByTestId("activations-tab")).not.toBeInTheDocument();
  });

  it("mounts the Spotted activations tab only when it is selected, for the base call", () => {
    profileIs({ ...FULL, callsign: "KK4PWJ" });
    renderAt("/call/KK4PWJ?tab=activations");
    expect(screen.getByRole("tab", { name: "Spotted activations" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("activations-tab")).toHaveTextContent("KK4PWJ");
    expect(screen.queryByText("Spots per month, since Long Lines started")).not.toBeInTheDocument();
    // The header stays above every tab.
    expect(screen.getByRole("heading", { name: "KK4PWJ" })).toBeInTheDocument();
  });

  it("switches tabs by link, keeping the page", async () => {
    const { user, where } = renderAt("/call/KK4PWJ");
    await user.click(screen.getByRole("tab", { name: "Spots" }));
    expect(where().dataset.search).toBe("?tab=spots");
    expect(screen.getByText("Recent spots")).toBeInTheDocument();
    expect(screen.getByText("N4XYZ")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Spotted activations" }));
    expect(where().dataset.search).toBe("?tab=activations");
    expect(screen.getByTestId("activations-tab")).toBeInTheDocument();
  });

  it("reads an unknown tab as Activity", () => {
    renderAt("/call/KK4PWJ?tab=nope");
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  });

  it("says when the Spots tab has nothing to show", () => {
    profileIs({ ...FULL, heard: { ...HEARD, recentSpots: [] } });
    renderAt("/call/KK4PWJ?tab=spots");
    expect(screen.getByText("No spots of KK4PWJ in the last 7 days.")).toBeInTheDocument();
    cleanup();
    profileIs(NOT_HEARD);
    renderAt("/call/G4ABC?tab=spots");
    expect(screen.getByText("Long Lines hasn't heard G4ABC on the air yet.")).toBeInTheDocument();
  });

  it("keeps the tab when the URL is made canonical", async () => {
    const { where } = renderAt("/call/kk4pwj?tab=activations");
    await waitFor(() => expect(where()).toHaveTextContent(/^\/call\/KK4PWJ$/));
    expect(where().dataset.search).toBe("?tab=activations");
  });

  it("keeps the tab when a portable call becomes its base", async () => {
    profileIs({ ...FULL, callsign: "KK4PWJ" });
    const { where } = renderAt("/call/KK4PWJ/P?tab=spots");
    await waitFor(() => expect(where()).toHaveTextContent(/^\/call\/KK4PWJ$/));
    expect(where().dataset.search).toBe("?tab=spots");
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
