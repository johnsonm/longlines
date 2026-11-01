import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { ActivationsTab } from "./ActivationsTab";
import { EMPTY_LIST, LIST } from "./fixtures";
import type { ActivationCard, CallsignActivations } from "./types";
import { useCallsignActivations, type LoadState } from "./useActivations";

vi.mock("./useActivations", () => ({ useCallsignActivations: vi.fn() }));

function listIs(state: Partial<LoadState<CallsignActivations>>) {
  vi.mocked(useCallsignActivations).mockReturnValue({ data: null, notFound: false, error: null, loading: false, ...state });
}

const ALERT = "Estimated from spots, not logs. Long Lines doesn't see contacts, so it can't tell whether an activation met the program's minimum.";

beforeEach(() => {
  setMobile(false);
  listIs({ data: LIST });
});

describe("ActivationsTab", () => {
  it("asks for the base call's list and shows the estimate alert and the four cards", () => {
    renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(useCallsignActivations).toHaveBeenCalledWith("KK4PWJ");
    expect(screen.getByText(ALERT)).toBeInTheDocument();
    expect(screen.getByText("Spotted activations")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Past 12 months")).toBeInTheDocument();
    expect(screen.getByText("References")).toBeInTheDocument();
    expect(screen.getByText("5 parks")).toBeInTheDocument();
    expect(screen.getByText("Time on air", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("5 h")).toBeInTheDocument();
    expect(screen.getByText("First spot to last spot, each activation")).toBeInTheDocument();
    expect(screen.getByText("Most activated")).toBeInTheDocument();
    expect(screen.getByText("US-1182", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText("Juniper Ridge Wildlife Management Area · 3 times")).toBeInTheDocument();
  });

  it("lists the recent activations by UTC day in a table, each with a View link", () => {
    renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Time (UTC)")).toBeInTheDocument();
    for (const name of ["Reference", "Time on air", "Bands · modes", "Spots", "Heard in"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByText("Mon 26 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText("Wed 28 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText("Wed 28 Oct 2026").closest("td")).toHaveTextContent("Wed 28 Oct 2026 · 3 parks in one day");

    const twofer = screen.getByText("US-1182 · US-1871").closest("tr")!;
    const row = within(twofer);
    expect(row.getByText("Two-fer")).toBeInTheDocument();
    expect(row.getByText("Juniper Ridge Wildlife Management Area · Willow Hollow Wildlife Management Area")).toBeInTheDocument();
    expect(row.getByText("18:12–19:40")).toBeInTheDocument();
    expect(row.getByText("1 h 28 min")).toBeInTheDocument();
    expect(row.getByText("20m · 40m")).toBeInTheDocument();
    expect(row.getByText("SSB · CW")).toBeInTheDocument();
    expect(row.getByText("11")).toBeInTheDocument();
    expect(row.getByText("5 states · 2 countries")).toBeInTheDocument();
    expect(row.getByRole("link", { name: /^View US-1182 · US-1871/ })).toHaveAttribute("href", "/activations/kjw2khkyj47f");
    expect(row.getByRole("link", { name: /^View/ })).toHaveTextContent("View");
  });

  it("chips and notes a single spot and both halves of a midnight split", () => {
    renderPage(<ActivationsTab callsign="KK4PWJ" />);
    const single = within(screen.getByText("US-2274").closest("tr")!);
    expect(single.getByText("1 spot")).toBeInTheDocument();
    expect(single.getByText("Only spotted once. It may have ended early or just not been re-spotted.")).toBeInTheDocument();
    expect(single.getByText("17:20")).toBeInTheDocument();
    expect(single.getAllByText("–")).toHaveLength(1);

    const later = within(screen.getByRole("link", { name: /^View US-1182, Fri 30 Oct 2026/ }).closest("tr")!);
    expect(later.getByText("Split at 00:00 UTC")).toBeInTheDocument();
    expect(later.getByText("Continued from Thu 29 Oct. POTA counts each UTC day as its own activation.")).toBeInTheDocument();
    const earlier = within(screen.getByRole("link", { name: /^View US-1182, Thu 29 Oct 2026/ }).closest("tr")!);
    expect(earlier.getByText("Split at 00:00 UTC")).toBeInTheDocument();
    expect(earlier.queryByText(/^Continued from/)).not.toBeInTheDocument();
  });

  it("shows ten activations, then all of them", async () => {
    const recent: ActivationCard[] = Array.from({ length: 12 }, (_, i) => ({
      ...LIST.recent[0]!, id: `id${i}`, references: [`US-${1000 + i}`], day: `2026-10-${String(30 - i).padStart(2, "0")}`,
    }));
    listIs({ data: { ...LIST, recent } });
    const { user } = renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(screen.getByText("US-1009")).toBeInTheDocument();
    expect(screen.queryByText("US-1010")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all 12" }));
    expect(screen.getByText("US-1011")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Show all/ })).not.toBeInTheDocument();
  });

  it("counts a whole day in its note when the first ten cut it short", () => {
    // Nine days of one activation, then a rover's day of three: only its newest row is in the first ten.
    const recent: ActivationCard[] = Array.from({ length: 12 }, (_, i) => ({
      ...LIST.recent[0]!,
      id: `id${i}`,
      program: "pota",
      references: [`US-${1000 + i}`],
      day: i < 9 ? `2026-10-${String(30 - i).padStart(2, "0")}` : "2026-10-20",
      startedAt: i < 9 ? `2026-10-${String(30 - i).padStart(2, "0")}T12:00:00Z` : `2026-10-20T${String(20 - i).padStart(2, "0")}:00:00Z`,
    }));
    listIs({ data: { ...LIST, recent } });
    renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(screen.getByText("US-1009")).toBeInTheDocument();
    expect(screen.queryByText("US-1010")).not.toBeInTheDocument();
    expect(screen.getByText("Tue 20 Oct 2026").closest("td")).toHaveTextContent("Tue 20 Oct 2026 · 3 parks in one day");
  });

  it("stacks rows on a phone, each a link", () => {
    setMobile(true);
    renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("First to last spot")).toBeInTheDocument();
    expect(screen.getByText("3 times")).toBeInTheDocument();
    const twofer = screen.getByRole("link", { name: /US-1182 · US-1871/ });
    expect(twofer).toHaveAttribute("href", "/activations/kjw2khkyj47f");
    expect(within(twofer).getByText("Two-fer")).toBeInTheDocument();
    expect(within(twofer).getByText("18:12–19:40 · 1 h 28 min")).toBeInTheDocument();
    expect(within(twofer).getByText("20m · 40m · SSB · CW · 11 spots · 5 states, 2 countries")).toBeInTheDocument();
    expect(screen.getByText("40m · 80m · SSB · 3 spots · 3 states. Continued from Thu 29 Oct.")).toBeInTheDocument();
    expect(screen.getByText("Wed 28 Oct 2026")).toBeInTheDocument();
  });

  it("says when there is nothing to show", () => {
    listIs({ data: EMPTY_LIST });
    renderPage(<ActivationsTab callsign="W1AW" />);
    expect(screen.getByText(ALERT)).toBeInTheDocument();
    expect(screen.getByText("Long Lines hasn't spotted an activation by W1AW yet.")).toBeInTheDocument();
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  });

  it("treats a hidden call as having none, and shows an outage and loading", () => {
    listIs({ notFound: true });
    const { unmount } = renderPage(<ActivationsTab callsign="W1HID" />);
    expect(screen.getByText("Long Lines hasn't spotted an activation by W1HID yet.")).toBeInTheDocument();
    unmount();

    listIs({ error: new Error("Spotted activations are unavailable right now.") });
    const failed = renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(screen.getByText("Spotted activations are unavailable right now.")).toBeInTheDocument();
    failed.unmount();

    listIs({ loading: true });
    renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows a dash for a summary with no most activated reference", () => {
    listIs({ data: { ...LIST, summary: { ...LIST.summary, activations: 0, mostActivated: null } } });
    renderPage(<ActivationsTab callsign="KK4PWJ" />);
    expect(screen.getByText("–", { selector: "div" })).toBeInTheDocument();
  });
});
