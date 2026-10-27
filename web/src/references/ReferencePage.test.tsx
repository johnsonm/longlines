import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { appValue, wrap } from "../test/render";
import { LocationProbe } from "../test/LocationProbe";
import { setMobile } from "../test/media";
import { NEVER_ACTIVATED, NOT_IN_LIST, PARK, RETIRED, SUMMIT, WWFF_REF } from "./fixtures";
import { ReferencePage } from "./ReferencePage";
import type { ReferenceProfile } from "./types";
import { useReferenceProfile } from "./useReferenceProfile";

vi.mock("../lib/api", () => ({}));
vi.mock("./useReferenceProfile", () => ({ useReferenceProfile: vi.fn() }));

// The canvas's moment: twelve minutes after N4MTS's newest spot.
const NOW = new Date("2026-10-26T19:03:00Z");

function profileIs(profile: ReferenceProfile | null, options: { notFound?: boolean; error?: unknown } = {}) {
  const error = options.error ?? null;
  const notFound = options.notFound ?? false;
  vi.mocked(useReferenceProfile).mockReturnValue({ profile, notFound, error, loading: !profile && !notFound && !error });
}

function renderAt(path: string, options: { signedIn?: boolean } = {}) {
  const app = appValue();
  const user = userEvent.setup({ delay: null });
  render(
    wrap(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/ref/:program/*" element={<ReferencePage signedIn={options.signedIn ?? false} />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
      app,
    ),
  );
  return { app, user, where: () => screen.getByTestId("location") };
}

/** A card by its title, so the same words in two cards don't collide. */
function card(title: string) {
  return within(screen.getByText(title).closest<HTMLElement>(".MuiCard-root")!);
}

/** The header card. */
function header() {
  return within(screen.getByRole("heading", { level: 1 }).closest<HTMLElement>(".MuiCard-root")!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setMobile(false);
  vi.mocked(useReferenceProfile).mockReset();
  profileIs(PARK);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReferencePage URL", () => {
  it("lower-cases the program and upper-cases the reference before asking for it", async () => {
    const { where } = renderAt("/ref/POTA/us-2763");
    await waitFor(() => expect(where()).toHaveTextContent(/^\/ref\/pota\/US-2763$/));
    expect(useReferenceProfile).toHaveBeenCalledWith("pota", "US-2763");
    expect(useReferenceProfile).not.toHaveBeenCalledWith("POTA", "us-2763");
  });

  it("keeps SOTA's slash and drops stray ones", async () => {
    profileIs(SUMMIT);
    const { where } = renderAt("/ref/sota/w4c/cm-001/");
    await waitFor(() => expect(where()).toHaveTextContent(/^\/ref\/sota\/W4C\/CM-001$/));
    expect(useReferenceProfile).toHaveBeenLastCalledWith("sota", "W4C/CM-001");
  });

  it("sends a page without a reference to lookup", async () => {
    const { where } = renderAt("/ref/pota/");
    await waitFor(() => expect(where()).toHaveTextContent("/lookup"));
  });

  it("answers a program without pages as not found, without asking", () => {
    renderAt("/ref/iota/EU-005");
    expect(screen.getByRole("heading", { name: "Reference not found" })).toBeInTheDocument();
    expect(screen.getByText("Long Lines has no reference EU-005.")).toBeInTheDocument();
    expect(useReferenceProfile).not.toHaveBeenCalled();
  });

  it("answers a reference with an empty segment as not found", () => {
    renderAt("/ref/sota/W4C//CM-001");
    expect(screen.getByText("Long Lines has no SOTA summit W4C//CM-001. Check the reference, like US-2763 or W4C/CM-001.")).toBeInTheDocument();
  });
});

describe("ReferencePage states", () => {
  it("shows progress while loading", () => {
    profileIs(null);
    renderAt("/ref/pota/US-2763");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows other errors as they come", () => {
    profileIs(null, { error: new Error("Too many lookups. Try again in a minute.") });
    renderAt("/ref/pota/US-2763");
    expect(screen.getByText("Too many lookups. Try again in a minute.")).toBeInTheDocument();
  });

  it("says when there is no such reference, with ways on", async () => {
    profileIs(null, { notFound: true });
    const { user, where } = renderAt("/ref/pota/US-27X3");
    expect(screen.getByRole("heading", { name: "Reference not found" })).toBeInTheDocument();
    expect(screen.getByText("Long Lines has no POTA park US-27X3. Check the reference, like US-2763 or W4C/CM-001.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Stats" })).toHaveAttribute("href", "/stats");
    await user.click(screen.getByRole("link", { name: "Callsign lookup" }));
    expect(where()).toHaveTextContent("/lookup");
  });

  it("shows a retired summit with its date and no alerts button", () => {
    profileIs(RETIRED);
    renderAt("/ref/sota/W4C/EM-031");
    expect(screen.getByText("This summit was retired from the SOTA list on Dec 31, 2019. Activations of it no longer count for SOTA.")).toBeInTheDocument();
    expect(header().getByText("Retired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /alerts/ })).not.toBeInTheDocument();
    expect(header().getByRole("link", { name: "SOTA" })).toHaveAttribute("href", "https://summits.sota.org.uk/summit/W4C/EM-031");
    expect(card("About this summit").getByText("Valid until")).toBeInTheDocument();
  });

  it("shows a reference outside the list with its spots, alerts, and no name, program site or About card", () => {
    profileIs(NOT_IN_LIST);
    renderAt("/ref/pota/US-12940");
    expect(screen.getByText(/^US-12940 isn't in the POTA park list\./)).toBeInTheDocument();
    expect(header().getByText("Not in the POTA list")).toBeInTheDocument();
    expect(header().queryByText("Mount Mitchell State Park")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to get alerts" })).toBeInTheDocument();
    expect(header().queryByRole("link", { name: "POTA" })).not.toBeInTheDocument();
    expect(screen.queryByText("About this park")).not.toBeInTheDocument();
    expect(screen.getByText("Activations per month, since Long Lines started")).toBeInTheDocument();
    expect(screen.getByText(/so these counts aren't POTA's own\.$/)).toBeInTheDocument();
  });

  it("gives a never-activated reference a quiet card beside its About card, and no figures", () => {
    profileIs(NEVER_ACTIVATED);
    renderAt("/ref/pota/US-4471");
    expect(screen.getByText("Long Lines hasn't heard an activation at US-4471 yet.")).toBeInTheDocument();
    expect(screen.getByText("About this park")).toBeInTheDocument();
    expect(screen.queryByText("Since Long Lines started")).not.toBeInTheDocument();
    expect(screen.queryByText("Activations in the past year")).not.toBeInTheDocument();
    expect(screen.queryByText("Top activators")).not.toBeInTheDocument();
    expect(screen.queryByText("Last activated")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to get alerts" })).toBeInTheDocument();
  });
});

describe("ReferencePage profile", () => {
  it("renders the header: reference, program, name, chips and the program's site", () => {
    renderAt("/ref/pota/US-2763");
    expect(screen.getByRole("heading", { level: 1, name: "US-2763" })).toBeInTheDocument();
    expect(header().getByText("POTA", { selector: ".MuiChip-label" }).closest(".MuiChip-root")).toHaveClass("MuiChip-colorPrimary");
    expect(header().getByText("Mount Mitchell State Park")).toBeInTheDocument();
    for (const chip of ["US-NC", "EM85", "Active"]) expect(header().getByText(chip)).toBeInTheDocument();
    const site = header().getByRole("link", { name: "POTA" });
    expect(site).toHaveAttribute("href", "https://pota.app/#/park/US-2763");
    expect(site).toHaveAttribute("target", "_blank");
    expect(header().getByRole("button", { name: "Share" })).toBeInTheDocument();
  });

  it("shows who is on the air now, linked, with today's count", () => {
    renderAt("/ref/pota/US-2763");
    expect(header().getByText("Last activated")).toBeInTheDocument();
    expect(header().getByText("On the air now")).toBeInTheDocument();
    expect(header().getByRole("link", { name: "N4MTS/P" })).toHaveAttribute("href", "/call/N4MTS");
    for (const chip of ["14062.0 kHz", "CW", "20m"]) expect(header().getByText(chip)).toBeInTheDocument();
    expect(header().getByText("12 min ago (18:51 UTC)")).toBeInTheDocument();
    expect(header().getByText("Spotted 18 times today, on 20m and 40m.")).toBeInTheDocument();
  });

  it("leaves out today's line past midnight, and On the air now for an older spot", () => {
    vi.setSystemTime(new Date("2026-10-27T00:30:00Z"));
    renderAt("/ref/pota/US-2763");
    expect(header().queryByText(/^Spotted .* today/)).not.toBeInTheDocument();
    expect(header().queryByText("On the air now")).not.toBeInTheDocument();
  });

  it("shows a summit's earlier spot by its date, without today's line", () => {
    profileIs(SUMMIT);
    renderAt("/ref/sota/W4C/CM-001");
    expect(header().getByText("SOTA", { selector: ".MuiChip-label" }).closest(".MuiChip-root")).toHaveClass("MuiChip-colorSecondary");
    for (const chip of ["W4C · NC-Central Mountains", "2,037 m", "10 points"]) expect(header().getByText(chip)).toBeInTheDocument();
    expect(header().getByText("Oct 12 (15:02 UTC)")).toBeInTheDocument();
    expect(header().getByText("146520.0 kHz")).toBeInTheDocument();
    expect(header().queryByText(/today/)).not.toBeInTheDocument();
    expect(screen.getByText("About this summit")).toBeInTheDocument();
    expect(screen.getByText("Spots from this summit, by band")).toBeInTheDocument();
  });

  it("shows a WWFF reference without a Last activated band when nothing was spotted lately", () => {
    profileIs(WWFF_REF);
    renderAt("/ref/wwff/KFF-6101");
    expect(header().getByText("WWFF", { selector: ".MuiChip-label" }).closest(".MuiChip-root")).toHaveClass("MuiChip-colorSuccess");
    expect(header().getByText("United States")).toBeInTheDocument();
    expect(screen.queryByText("Last activated")).not.toBeInTheDocument();
    expect(screen.getByText("From the WWFF directory. Refreshed weekly.")).toBeInTheDocument();
    expect(screen.getByText(/Reference details come from the WWFF directory\.$/)).toBeInTheDocument();
  });

  it("renders the figures, About card, charts and tables", () => {
    renderAt("/ref/pota/US-2763");
    expect(screen.getByText("148")).toBeInTheDocument();
    expect(screen.getByText("Since Long Lines started")).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    expect(screen.getByText("Different callsigns")).toBeInTheDocument();
    expect(screen.getByText("3,412")).toBeInTheDocument();
    expect(screen.getByText("Nov 2, 2025")).toBeInTheDocument();
    expect(card("First activated").getByRole("link", { name: "KJ4ABS" })).toHaveAttribute("href", "/call/KJ4ABS");
    expect(card("First activated").getByText(/^By/)).toHaveTextContent("By KJ4ABS");

    expect(screen.getByText("Activations in the past year")).toBeInTheDocument();
    expect(screen.getByText("Activators spotted at US-2763 each day. Hover a day to see who.")).toBeInTheDocument();

    const about = card("About this park");
    expect(about.getByText("From the POTA park list. Refreshed weekly.")).toBeInTheDocument();
    expect(about.getByText("Parks on the Air")).toBeInTheDocument();
    expect(about.getByText("35.7650, -82.2652")).toBeInTheDocument();

    expect(screen.getByText("Activations per month, since Long Lines started")).toBeInTheDocument();
    expect(screen.getByText("Spots from this park, by band")).toBeInTheDocument();
    expect(screen.getByText("Share of spots")).toBeInTheDocument();

    const top = card("Top activators");
    expect(top.getByText("Most activations here, all time")).toBeInTheDocument();
    expect(top.getByRole("link", { name: "N4MTS/P" })).toHaveAttribute("href", "/call/N4MTS");
    expect(top.getByText("22")).toBeInTheDocument();
    expect(top.getByText("Oct 25, 2025")).toBeInTheDocument();

    const recent = card("Recent activations");
    expect(recent.getByText("Newest first. An activation is one activator spotted here on one UTC day.")).toBeInTheDocument();
    expect(recent.getByText("20m, 40m")).toBeInTheDocument();
    expect(recent.getByText("USB, SSB")).toBeInTheDocument();
    expect(recent.getAllByRole("link", { name: "KJ4ABS" })[0]).toHaveAttribute("href", "/call/KJ4ABS");

    const spots = card("Recent spots");
    expect(spots.getByText("Spots from this park in the last 7 days, newest first")).toBeInTheDocument();
    expect(spots.getByText("Oct 26 18:51")).toBeInTheDocument();
    expect(spots.getByText("7035.5 kHz")).toBeInTheDocument();
    expect(spots.getByText("Strong in TN")).toBeInTheDocument();
    expect(spots.getByText("KX4FBS")).toBeInTheDocument();
    expect(spots.getByText("–")).toBeInTheDocument();

    expect(screen.getByText(/^An activation here means an activator was spotted at US-2763 on that UTC day\./)).toBeInTheDocument();
  });

  it("leaves Recent spots out when the last 7 days had none", () => {
    profileIs({ ...PARK, recentSpots: [] });
    renderAt("/ref/pota/US-2763");
    expect(screen.queryByText("Recent spots")).not.toBeInTheDocument();
  });

  it("lays out phone rows, the time under the chips and no today line", () => {
    setMobile(true);
    renderAt("/ref/pota/US-2763");
    expect(header().getByText("12 min ago (18:51 UTC)")).toBeInTheDocument();
    expect(header().queryByText(/^Spotted .* today/)).not.toBeInTheDocument();
    expect(screen.getByText("Activators spotted at US-2763 each day. Tap a day to see who.")).toBeInTheDocument();
    expect(card("Top activators").getByText("22 · Oct 26")).toBeInTheDocument();
    expect(card("Top activators").getByText("14 · Oct 25, 2025")).toBeInTheDocument();
    expect(card("Recent activations").getByText("20m, 40m · CW · 18 spots")).toBeInTheDocument();
    const spots = card("Recent spots");
    expect(spots.getByText("14062.0 kHz · CW · by KX4FBS")).toBeInTheDocument();
    expect(spots.getByText("7035.5 kHz · CW · self-spot")).toBeInTheDocument();
    expect(spots.getByText("18:51")).toBeInTheDocument();
    expect(spots.getByText("Oct 25")).toBeInTheDocument();
    expect(spots.getAllByRole("link", { name: "N4MTS/P" })[0]).toHaveAttribute("href", "/call/N4MTS");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });
});

describe("Get alerts", () => {
  it("sends a signed-out visitor to sign in and back", async () => {
    const { user, where } = renderAt("/ref/pota/US-2763");
    await user.click(screen.getByRole("button", { name: "Sign in to get alerts" }));
    expect(where()).toHaveTextContent("/signin");
    expect(JSON.parse(where().dataset.state ?? "null")).toEqual({ from: "/ref/pota/US-2763" });
  });

  it("opens the editor on the program's source with this reference as the filter", async () => {
    profileIs(SUMMIT);
    const { user, where } = renderAt("/ref/sota/W4C/CM-001", { signedIn: true });
    await user.click(screen.getByRole("button", { name: "Get alerts for W4C/CM-001" }));
    expect(where()).toHaveTextContent(/^\/connections\/new$/);
    expect(where().dataset.search).toBe("?source=sotawatch&reference=W4C%2FCM-001");
  });
});

describe("Share", () => {
  it("copies the page's link", async () => {
    vi.useRealTimers();
    const { user, app } = renderAt("/ref/pota/US-2763");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/ref/pota/US-2763`);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Link copied."));
  });
});
