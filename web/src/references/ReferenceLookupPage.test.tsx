import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { searchReferences } from "../lib/api";
import { appValue, wrap } from "../test/render";
import { LocationProbe } from "../test/LocationProbe";
import { setMobile } from "../test/media";
import type { StatsPayload } from "../stats/types";
import { useStats } from "../stats/useStats";
import { ReferenceLookupPage, SEARCH_FAILED } from "./ReferenceLookupPage";
import { EMPTY, MITCHELL, ONE } from "./searchFixtures";
import type { ReferenceSearch } from "./types";

vi.mock("../lib/api", () => ({ searchReferences: vi.fn() }));
vi.mock("../stats/useStats", () => ({ useStats: vi.fn() }));

// The canvas's moment.
const NOW = new Date("2026-10-26T19:03:00Z");

// Only topReferences matters here; six, so the card's cut to five shows.
const PAYLOAD = {
  topReferences: [
    { reference: "US-2763", name: "Mount Mitchell State Park", program: "POTA", activations: 40, spots: 1412 },
    { reference: "US-0001", name: "Acadia National Park", program: "POTA", activations: 30, spots: 388 },
    { reference: "W4C/CM-001", name: "Mount Mitchell", program: "SOTA", activations: 12, spots: 201 },
    { reference: "KFF-6101", name: null, program: "WWFF", activations: 9, spots: 156 },
    { reference: "US-0002", name: "Alagnak Wild River National Park", program: "POTA", activations: 8, spots: 140 },
    { reference: "US-0003", name: "Aniakchak National Preserve", program: "POTA", activations: 7, spots: 120 },
  ],
} as StatsPayload;

/** Back, as the browser's button does it. */
function BackButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => void navigate(-1)}>Browser back</button>;
}

function renderAt(search = "") {
  const user = userEvent.setup({ delay: null });
  render(
    wrap(
      <MemoryRouter initialEntries={[`/ref${search}`]}>
        <Routes>
          <Route path="/ref" element={<ReferenceLookupPage />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
        <BackButton />
      </MemoryRouter>,
      appValue(),
    ),
  );
  const probe = () => screen.getByTestId("location");
  return {
    user,
    where: () => `${probe().textContent ?? ""}${probe().dataset.search ?? ""}`,
    field: () => screen.getByRole("searchbox", { name: "Reference or name" }),
  };
}

function answer(search: ReferenceSearch) {
  vi.mocked(searchReferences).mockResolvedValue(search);
}

/** The results card, by its title. */
async function results(title: string) {
  const heading = await screen.findByRole("heading", { name: title });
  return within(heading.closest<HTMLElement>(".MuiCard-root")!);
}

/** A result row: the link that holds this reference. */
function row(reference: string) {
  return within(screen.getByText(reference).closest<HTMLElement>("a")!);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setMobile(false);
  vi.mocked(searchReferences).mockReset();
  vi.mocked(useStats).mockReset().mockReturnValue({ stats: { payload: PAYLOAD, generatedAt: "2026-10-26T18:05:00Z" }, loading: false, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReferenceLookupPage form", () => {
  it("explains the page, labels the field and focuses it on desktop", () => {
    const { field } = renderAt();
    expect(screen.getByRole("heading", { level: 1, name: "Reference lookup" })).toBeInTheDocument();
    expect(screen.getByText("Find a POTA park, SOTA summit or WWFF reference by its reference or its name.")).toBeInTheDocument();
    expect(screen.getByLabelText("Reference or name", { selector: "label + * input, input" })).toBe(field());
    expect(field()).toHaveAttribute("placeholder", "Reference or name, like US-2763 or Mount Mitchell");
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Look up" })).toHaveTextContent("Look up");
    const chips = within(screen.getByRole("group", { name: "Program" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["All programs", "POTA parks", "SOTA summits", "WWFF references"]);
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(searchReferences).not.toHaveBeenCalled();
  });

  it("uses the short placeholder, an icon button and short chips on phones, without focusing", () => {
    setMobile(true);
    const { field } = renderAt();
    expect(field()).toHaveAttribute("placeholder", "Reference or name, like US-2763");
    expect(field()).not.toHaveFocus();
    const button = screen.getByRole("button", { name: "Look up" });
    expect(button).toHaveTextContent("");
    expect(button.querySelector("svg")).not.toBeNull();
    const chips = within(screen.getByRole("group", { name: "Program" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["All", "POTA", "SOTA", "WWFF"]);
  });

  it("puts a submitted search in the URL and asks once, not per keystroke", async () => {
    answer(MITCHELL);
    const { user, where, field } = renderAt();
    await user.type(field(), "  mitchell ");
    expect(searchReferences).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(where()).toBe("/ref?q=mitchell");
    await results('6 matches for "mitchell"');
    expect(searchReferences).toHaveBeenCalledTimes(1);
    expect(searchReferences).toHaveBeenCalledWith("mitchell", null);

    // The same search again adds no history entry and no request.
    await user.type(field(), "{Enter}");
    expect(searchReferences).toHaveBeenCalledTimes(1);
  });

  it("refuses a search outside the bounds without asking, until the field changes", async () => {
    const { user, where, field } = renderAt();
    await user.type(field(), "x{Enter}");
    expect(screen.getByText("A search is 2 to 64 characters, at most 6 words.")).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(where()).toBe("/ref");
    await user.type(field(), "y");
    expect(screen.queryByText("A search is 2 to 64 characters, at most 6 words.")).not.toBeInTheDocument();
    await user.clear(field());
    await user.type(field(), "a b c d e f g{Enter}");
    expect(screen.getByText("A search is 2 to 64 characters, at most 6 words.")).toBeInTheDocument();
    expect(searchReferences).not.toHaveBeenCalled();
  });

  it("refuses a link's search outside the bounds without asking", () => {
    const { field } = renderAt("?q=x");
    expect(field()).toHaveValue("x");
    expect(screen.getByText("A search is 2 to 64 characters, at most 6 words.")).toBeInTheDocument();
    expect(searchReferences).not.toHaveBeenCalled();
    expect(screen.queryByText("Most spotted this week")).not.toBeInTheDocument();
  });

  it("filters by program through the URL, keeping the search", async () => {
    answer(ONE);
    const { user, where } = renderAt("?q=filtered");
    await results('1 match for "filtered"');
    await user.click(screen.getByRole("button", { name: "SOTA summits" }));
    expect(where()).toBe("/ref?q=filtered&program=sota");
    expect(screen.getByRole("button", { name: "SOTA summits" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(searchReferences).toHaveBeenLastCalledWith("filtered", "sota"));
    await user.click(screen.getByRole("button", { name: "All programs" }));
    expect(where()).toBe("/ref?q=filtered");
  });

  it("keeps a program with no search, and asks nothing", async () => {
    const { user, where } = renderAt();
    await user.click(screen.getByRole("button", { name: "WWFF references" }));
    expect(where()).toBe("/ref?program=wwff");
    expect(searchReferences).not.toHaveBeenCalled();
    expect(screen.getByText("Most spotted this week")).toBeInTheDocument();
  });

  it("reads a shared link, and Back returns to the search before", async () => {
    answer(ONE);
    const { user, where, field } = renderAt("?q=%20first%20&program=pota");
    expect(field()).toHaveValue("first");
    await results('1 match for "first"');
    expect(searchReferences).toHaveBeenCalledWith("first", "pota");
    await user.clear(field());
    await user.type(field(), "second{Enter}");
    expect(where()).toBe("/ref?q=second&program=pota");
    await results('1 match for "second"');

    await user.click(screen.getByRole("button", { name: "Browser back" }));
    expect(where()).toBe("/ref?q=%20first%20&program=pota");
    expect(field()).toHaveValue("first");
    await results('1 match for "first"');
    // Back is served from the cache.
    expect(searchReferences).toHaveBeenCalledTimes(2);
  });

  it("clears the search with an empty field, back to the most spotted", async () => {
    answer(ONE);
    const { user, where, field } = renderAt("?q=clearing&program=sota");
    await results('1 match for "clearing"');
    await user.clear(field());
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(where()).toBe("/ref?program=sota");
    expect(screen.getByText("Most spotted this week")).toBeInTheDocument();
  });

  it("ignores a program without pages", async () => {
    answer(ONE);
    renderAt("?q=ignored&program=iota");
    await results('1 match for "ignored"');
    expect(searchReferences).toHaveBeenCalledWith("ignored", null);
    expect(screen.getByRole("button", { name: "All programs" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("ReferenceLookupPage results", () => {
  it("lists the matches, most activated first, each linking to its page", async () => {
    answer(MITCHELL);
    renderAt("?q=mitchell");
    const card = await results('6 matches for "mitchell"');
    expect(card.getByText("Most activated first")).toBeInTheDocument();
    const links = card.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/ref/pota/US-2763", "/ref/sota/W4C/CM-001", "/ref/wwff/KFF-2747", "/ref/pota/US-4561", "/ref/sota/VK3/VE-123", "/ref/sota/W7O/CN-099",
    ]);
    expect(card.queryByText("Showing the top 25. Add a word to narrow it down.")).not.toBeInTheDocument();
  });

  it("shows each row's program, name, detail and activations", async () => {
    answer(MITCHELL);
    renderAt("?q=mitchell&program=");
    await results('6 matches for "mitchell"');

    const park = row("US-2763");
    expect(park.getByText("POTA").closest(".MuiChip-root")).toHaveClass("MuiChip-colorPrimary");
    expect(park.getByText("US-NC · EM85")).toBeInTheDocument();
    expect(park.getByText("148 activations · last Oct 26")).toBeInTheDocument();
    expect(park.queryByText("Retired")).not.toBeInTheDocument();

    const summit = row("W4C/CM-001");
    expect(summit.getByText("SOTA").closest(".MuiChip-root")).toHaveClass("MuiChip-colorSecondary");
    expect(summit.getByText("W4C · NC-Central Mountains · 2,037 m · 10 points")).toBeInTheDocument();
    expect(summit.getByText("23 activations · last Oct 12")).toBeInTheDocument();

    const wwff = row("KFF-2747");
    expect(wwff.getByText("WWFF").closest(".MuiChip-root")).toHaveClass("MuiChip-colorSuccess");
    expect(wwff.getByText("United States · North Carolina")).toBeInTheDocument();

    expect(row("US-4561").getByText("1 activation · last Jul 4, 2025")).toBeInTheDocument();
    expect(row("US-4561").getByText("US-NC, US-VA")).toBeInTheDocument();
    expect(row("VK3/VE-123").getByText("No activations yet")).toBeInTheDocument();

    const retired = row("W7O/CN-099");
    expect(retired.getByText("Retired").closest(".MuiChip-root")).toHaveClass("MuiChip-outlined");
    expect(retired.getByText("No activations yet")).toBeInTheDocument();
  });

  it("sets the matched words of each name in medium weight", async () => {
    answer(MITCHELL);
    renderAt("?q=MITCHELL%20park");
    await results('6 matches for "MITCHELL park"');
    const name = row("US-2763").getByText((_, el) => el?.textContent === "Mount Mitchell State Park" && el.classList.contains("MuiTypography-body2"));
    const marked = [...name.querySelectorAll(".MuiTypography-subtitle2")].map((m) => m.textContent);
    expect(marked).toEqual(["Mitchell", "Park"]);
  });

  it("says 1 match, and leaves out a missing name and an empty detail line", async () => {
    answer(ONE);
    renderAt("?q=US-9999");
    const card = await results('1 match for "US-9999"');
    const link = card.getByRole("link");
    expect(link).toHaveAttribute("href", "/ref/pota/US-9999");
    expect(within(link).getByText("2 activations · last Oct 1")).toBeInTheDocument();
    expect(link.querySelectorAll(".MuiTypography-body2")).toHaveLength(1);
  });

  it("says when there are more than 25", async () => {
    answer({ ...MITCHELL, more: true });
    renderAt("?q=us");
    const card = await results('6 matches for "us"');
    expect(card.getByText("Showing the top 25. Add a word to narrow it down.")).toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    answer(EMPTY);
    renderAt("?q=mitchel%20park%20nc");
    expect(await screen.findByText('No parks, summits or WWFF references match "mitchel park nc".')).toBeInTheDocument();
    expect(screen.queryByText("Most activated first")).not.toBeInTheDocument();
    expect(screen.queryByText("Most spotted this week")).not.toBeInTheDocument();
  });

  it("stacks a row on phones", async () => {
    setMobile(true);
    answer(MITCHELL);
    renderAt("?q=phone");
    await results('6 matches for "phone"');
    const summit = row("W4C/CM-001");
    expect(summit.getByText("SOTA")).toBeInTheDocument();
    expect(summit.getByText("W4C · NC-Central Mountains · 2,037 m · 10 points")).toBeInTheDocument();
    expect(summit.getByText("23 activations · last Oct 12")).toBeInTheDocument();
    expect(row("W7O/CN-099").getByText("Retired")).toBeInTheDocument();
  });

  it("shows the function's message when a search fails, and a fallback without one", async () => {
    vi.mocked(searchReferences).mockRejectedValueOnce(new Error("Too many lookups. Try again in a minute."));
    renderAt("?q=limited");
    expect(await screen.findByText("Too many lookups. Try again in a minute.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("asks again when the failed search is submitted again", async () => {
    vi.mocked(searchReferences).mockRejectedValueOnce(new Error("Too many lookups. Try again in a minute."));
    const { user, where } = renderAt("?q=retried");
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many lookups. Try again in a minute.");
    answer(MITCHELL);
    await user.click(screen.getByRole("button", { name: "Look up" }));
    await results('6 matches for "retried"');
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(searchReferences).toHaveBeenCalledTimes(2);
    expect(where()).toBe("/ref?q=retried");
    // Answered now, the same search is the cache's again.
    await user.click(screen.getByRole("button", { name: "Look up" }));
    expect(searchReferences).toHaveBeenCalledTimes(2);
  });

  it("asks again from the program chip already chosen, whatever order the link put the parameters in", async () => {
    vi.mocked(searchReferences).mockRejectedValueOnce(new Error("Couldn't reach the server."));
    const { user, where } = renderAt("?program=sota&q=reordered");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the server.");
    answer(MITCHELL);
    await user.click(screen.getByRole("button", { name: "SOTA summits" }));
    await results('6 matches for "reordered"');
    expect(searchReferences).toHaveBeenLastCalledWith("reordered", "sota");
    expect(where()).toBe("/ref?q=reordered&program=sota");
  });

  it("falls back to its own words for a failure without a message", async () => {
    vi.mocked(searchReferences).mockRejectedValueOnce(new Error(""));
    renderAt("?q=silent");
    expect(await screen.findByText(SEARCH_FAILED)).toBeInTheDocument();
    expect(SEARCH_FAILED).toBe("Couldn't search the reference lists.");
  });

  it("shows progress while it asks", async () => {
    vi.mocked(searchReferences).mockReturnValue(new Promise(() => {}));
    renderAt("?q=waiting");
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
  });
});

describe("ReferenceLookupPage with no search", () => {
  it("shows the Stats snapshot's five most spotted references, linked, with their spots", () => {
    renderAt();
    const card = within(screen.getByRole("heading", { name: "Most spotted this week" }).closest<HTMLElement>(".MuiCard-root")!);
    expect(card.getByText("Parks, summits and WWFF references")).toBeInTheDocument();
    const links = card.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/ref/pota/US-2763", "/ref/pota/US-0001", "/ref/sota/W4C/CM-001", "/ref/wwff/KFF-6101", "/ref/pota/US-0002", "/stats",
    ]);
    expect(within(links[0]!).getByText("Mount Mitchell State Park")).toBeInTheDocument();
    // The references are list rows, not headings: the card's title is the only one.
    expect(card.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Most spotted this week"]);
    expect(within(links[0]!).getByText("1,412")).toBeInTheDocument();
    expect(within(links[0]!).getByText("POTA").closest(".MuiChip-root")).toHaveClass("MuiChip-colorPrimary");
    expect(within(links[2]!).getByText("SOTA").closest(".MuiChip-root")).toHaveClass("MuiChip-colorSecondary");
    expect(within(links[3]!).getByText("WWFF").closest(".MuiChip-root")).toHaveClass("MuiChip-colorSuccess");
    expect(card.queryByText("US-0003")).not.toBeInTheDocument();
    expect(card.getByRole("link", { name: "More on the Stats page" })).toHaveAttribute("href", "/stats");
    expect(searchReferences).not.toHaveBeenCalled();
  });

  it("leaves the card out without a snapshot", () => {
    vi.mocked(useStats).mockReturnValue({ stats: null, loading: false, error: null });
    renderAt();
    expect(screen.queryByText("Most spotted this week")).not.toBeInTheDocument();
  });

  it("keeps a reference the router can't hold as plain text", () => {
    vi.mocked(useStats).mockReturnValue({
      stats: {
        payload: { topReferences: [{ reference: "W4C//CM-001", name: null, program: "SOTA", activations: 1, spots: 2 }] } as StatsPayload,
        generatedAt: "2026-10-26T18:05:00Z",
      },
      loading: false,
      error: null,
    });
    renderAt();
    const card = within(screen.getByRole("heading", { name: "Most spotted this week" }).closest<HTMLElement>(".MuiCard-root")!);
    expect(card.getByText("W4C//CM-001").closest("a")).toBeNull();
    expect(card.getAllByRole("link").map((l) => l.textContent)).toEqual(["More on the Stats page"]);
  });
});
