import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { ActivationPage } from "./ActivationPage";
import { CONTINUED, COUNTRIES, IOTA, NULL_SPOTTER, SINGLE, SPLIT, TWOFER } from "./fixtures";
import type { SpottedActivation } from "./types";
import { useSpottedActivation, type LoadState } from "./useActivations";

vi.mock("./useActivations", () => ({ useSpottedActivation: vi.fn() }));

function pageIs(state: Partial<LoadState<SpottedActivation>>) {
  vi.mocked(useSpottedActivation).mockReturnValue({ data: null, notFound: false, error: null, loading: false, ...state });
}

function renderAt(id: string) {
  return renderPage(<ActivationPage id={id} />, { route: `/activations/${id}` });
}

beforeEach(() => {
  setMobile(false);
  pageIs({ data: TWOFER });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActivationPage", () => {
  it("heads the page with the activator, references, names and when", () => {
    renderAt(TWOFER.id);
    expect(useSpottedActivation).toHaveBeenCalledWith("kjw2khkyj47f");
    expect(screen.getByRole("link", { name: "KK4PWJ spotted activations" })).toHaveAttribute("href", "/call/KK4PWJ?tab=activations");
    expect(screen.getByText("Spotted activation · POTA")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("KK4PWJ at US-1182 · US-1871");
    expect(within(heading).getByRole("link", { name: "KK4PWJ" })).toHaveAttribute("href", "/call/KK4PWJ");
    expect(screen.getByText("Juniper Ridge Wildlife Management Area · Willow Hollow Wildlife Management Area")).toBeInTheDocument();
    expect(screen.getByText("Mon 26 Oct 2026 · 18:12–19:40 UTC · 1 h 28 min")).toBeInTheDocument();
    // The heading already shows both references.
    expect(screen.queryByText("Two-fer")).not.toBeInTheDocument();
  });

  it("sets the browser tab's title while it is open", () => {
    document.title = "Long Lines";
    const { unmount } = renderAt(TWOFER.id);
    expect(document.title).toBe("KK4PWJ at US-1182 · US-1871 · Spotted activation");
    unmount();
    expect(document.title).toBe("Long Lines");
  });

  it("copies the canonical link and says so", async () => {
    const { user, app } = renderAt(TWOFER.id);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/activations/kjw2khkyj47f`);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Link copied."));
  });

  it("says when the link couldn't be copied", async () => {
    const { user, app } = renderAt(TWOFER.id);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't copy the link."));
  });

  it("lists the On the air figures", () => {
    renderAt(TWOFER.id);
    const card = within(screen.getByText("On the air").closest<HTMLElement>(".MuiCard-root")!);
    expect(card.getByText("1 h 28 min · 18:12–19:40 UTC")).toBeInTheDocument();
    expect(card.getByText("Bands")).toBeInTheDocument();
    expect(card.getByText("20m · 40m")).toBeInTheDocument();
    expect(card.getByText("SSB · CW")).toBeInTheDocument();
    expect(card.getByText("11 · POTA 7 · RBN 3 · DX cluster 1")).toBeInTheDocument();
    expect(card.getByText("5 states · 2 countries")).toBeInTheDocument();
    expect(card.getByText("Fed. Rep. of Germany · about 7,000 km")).toBeInTheDocument();
    expect(card.getByText("Not known. Long Lines only sees spots.")).toBeInTheDocument();
  });

  it("draws the map, the timeline and the first spots, then all of them", async () => {
    const { user } = renderAt(TWOFER.id);
    expect(screen.getByText("Where KK4PWJ was heard")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Lines from Juniper Ridge Wildlife Management Area to 4 states/ })).toBeInTheDocument();
    expect(screen.getByText("Heard in 5 states, plus Fed. Rep. of Germany and Canada.")).toBeInTheDocument();
    expect(screen.getByText("Spots over time")).toBeInTheDocument();

    const spots = within(screen.getByText("Spots", { selector: ".MuiCardHeader-title" }).closest<HTMLElement>(".MuiCard-root")!);
    for (const name of ["Time (UTC)", "Source", "Heard by", "kHz", "Mode", "Reference"]) {
      expect(spots.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    expect(spots.getByText("self-spot", { exact: false })).toBeInTheDocument();
    expect(spots.getByRole("link", { name: "N4KJS" })).toHaveAttribute("href", "/call/N4KJS");
    expect(spots.getByText("14,239.1")).toBeInTheDocument();
    expect(spots.getAllByRole("row")).toHaveLength(7);
    await user.click(screen.getByRole("button", { name: "Show all 11 spots" }));
    expect(spots.getAllByRole("row")).toHaveLength(12);
    expect(screen.queryByRole("button", { name: /^Show all/ })).not.toBeInTheDocument();
  });

  it("explains the estimate", () => {
    renderAt(TWOFER.id);
    expect(screen.getByText("How this was estimated")).toBeInTheDocument();
    expect(screen.getByText(/^Long Lines grouped KK4PWJ's spots at these references with no gap longer than 45 minutes/)).toBeInTheDocument();
  });

  it("stacks the spots and folds bands and modes on a phone", () => {
    setMobile(true);
    renderAt(TWOFER.id);
    expect(screen.getByText("Bands · modes")).toBeInTheDocument();
    expect(screen.getByText("20m · 40m · SSB · CW")).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.getByText("North Carolina · 14,273.1 kHz · SSB · US-1871")).toBeInTheDocument();
    expect(screen.getByText("14,239.1 kHz · SSB · US-1182")).toBeInTheDocument();
    expect(screen.getAllByText(/self-spot/).length).toBeGreaterThan(0);
  });

  it("links the halves of a midnight split", () => {
    pageIs({ data: SPLIT });
    const { unmount } = renderAt(SPLIT.id);
    expect(screen.getByText("Split at 00:00 UTC")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continued from Thu 29 Oct." })).toHaveAttribute("href", "/activations/n7h4dcckfp3d");
    unmount();
    pageIs({ data: CONTINUED });
    renderAt(CONTINUED.id);
    expect(screen.getByRole("link", { name: "Continued on Fri 30 Oct." })).toHaveAttribute("href", "/activations/grw3jgwakszn");
  });

  it("says a single spot is one, with no duration", () => {
    pageIs({ data: SINGLE });
    renderAt(SINGLE.id);
    expect(screen.getByText("1 spot")).toBeInTheDocument();
    expect(screen.getByText("Wed 28 Oct 2026 · 17:20 UTC")).toBeInTheDocument();
    expect(screen.getByText("17:20 UTC")).toBeInTheDocument();
  });

  it("says where a reference has no location, and dashes what is unknown", () => {
    pageIs({ data: IOTA });
    renderAt(IOTA.id);
    expect(screen.getByText("Spotted activation · IOTA")).toBeInTheDocument();
    expect(screen.getByText("Location not known for this reference.")).toBeInTheDocument();
    expect(screen.queryByTestId("heard-lines")).not.toBeInTheDocument();
    const card = within(screen.getByText("On the air").closest<HTMLElement>(".MuiCard-root")!);
    expect(card.getAllByText("–")).toHaveLength(2);
  });

  it("shows a spot with no spotter, and countries without lines", () => {
    pageIs({ data: NULL_SPOTTER });
    const { unmount } = renderAt(NULL_SPOTTER.id);
    expect(screen.getByText("Spotted activation · SOTA")).toBeInTheDocument();
    expect(screen.getAllByText("–").length).toBeGreaterThan(0);
    unmount();
    pageIs({ data: COUNTRIES });
    renderAt(COUNTRIES.id);
    expect(screen.getByText("Heard in Canada and Japan.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Map of the states where K0AAAS was heard" })).toBeInTheDocument();
  });

  it("replaces a redirected id with the canonical one", async () => {
    const { getByTestId } = renderPage(<ActivationPage id="oldoldoldold" />, { route: "/activations/:id" });
    await waitFor(() => expect(getByTestId("location")).toHaveTextContent("/activations/kjw2khkyj47f"));
  });

  it("shows not found, an outage and loading", () => {
    pageIs({ notFound: true });
    const { unmount } = renderAt("aaaaaaaaaaaa");
    expect(screen.getByRole("heading", { name: "Spotted activation not found" })).toBeInTheDocument();
    expect(screen.getByText("Spotted activation not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Callsign lookup" })).toHaveAttribute("href", "/lookup");
    expect(screen.getByRole("link", { name: "Stats" })).toHaveAttribute("href", "/stats");
    unmount();

    pageIs({ error: new Error("Spotted activations are unavailable right now.") });
    const failed = renderAt("aaaaaaaaaaaa");
    expect(screen.getByText("Spotted activations are unavailable right now.")).toBeInTheDocument();
    failed.unmount();

    pageIs({ loading: true });
    renderAt("aaaaaaaaaaaa");
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });
});
