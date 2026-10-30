import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { NOW, bands, card, parks, progress, states } from "../test/goals";
import { ApiError, deleteGoal, loadGoal, saveGoal, searchReferences } from "../lib/api";
import type { ReferenceSearchResult } from "../references/types";
import { GoalEditPage } from "./GoalEditPage";
import type { GoalEntry, GoalInput, GoalProgress } from "./types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    code: string | undefined;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
  loadGoal: vi.fn(),
  saveGoal: vi.fn(),
  deleteGoal: vi.fn(),
  searchReferences: vi.fn(),
}));

function park(reference: string, name: string | null, active = true): ReferenceSearchResult {
  return {
    program: "pota", reference, name, active, validTo: null, location: "US-NC", association: null, region: null, country: null,
    grid: null, altitudeM: null, points: null, activations: 3, lastDay: "2026-10-20",
  };
}

beforeEach(() => {
  for (const fn of [loadGoal, saveGoal, deleteGoal, searchReferences]) vi.mocked(fn).mockReset();
  vi.mocked(saveGoal).mockResolvedValue("n1");
  vi.mocked(deleteGoal).mockResolvedValue();
  vi.mocked(searchReferences).mockResolvedValue({ results: [park("US-2741", "Mount Mitchell State Park"), park("US-9000", null, false)], more: false });
  setMobile(false);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  setMobile(false);
});

function edit(p: GoalProgress = progress()) {
  vi.mocked(loadGoal).mockResolvedValue(p);
  return renderPage(<GoalEditPage id={p.list.id} />, { route: `/goals/${p.list.id}/edit` });
}

const section = (name: string) => screen.getByRole("region", { name });
const location = () => screen.getByTestId("location").textContent;
const saved = (): GoalInput => vi.mocked(saveGoal).mock.calls.at(-1)![0];
const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

/** Open a select by its label and pick an option. */
async function choose(user: ReturnType<typeof edit>["user"], label: string, option: string, within_: HTMLElement = document.body) {
  await user.click(within(within_).getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
}

describe("GoalEditPage on a desktop", () => {
  it("loads the list into the form", async () => {
    edit();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "Edit goal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Goals" })).toHaveAttribute("href", "/goals");
    expect(screen.getByRole("link", { name: "2026 chase" })).toHaveAttribute("href", "/goals/n1");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("2026 chase");

    const window = within(section("Time window"));
    expect(window.getByText("Which contacts count toward this goal.")).toBeInTheDocument();
    expect(window.getByRole("combobox", { name: "Counts contacts" })).toHaveTextContent("Between dates");
    expect(window.getByLabelText("Starts")).toHaveValue("2026-01-01");
    expect(window.getByLabelText("Ends")).toHaveValue("2026-12-31");
    expect(window.getByText(/^Choose "No end date" for something open-ended/)).toBeInTheDocument();
    expect(screen.getByText("Long Lines only knows contacts since Oct 16, 2026")).toBeInTheDocument();

    const marking = within(section("How entries get marked"));
    expect(marking.getByRole("combobox", { name: "Mark entries worked" })).toHaveTextContent("From my log, using the relay");
    expect(marking.getByText(/^The relay is connected\. Choose "By hand only"/)).toBeInTheDocument();

    expect(screen.getByText("A spot alerts you while it matches anything you still need. Add as many requirements as you like.")).toBeInTheDocument();
    const st = within(section("States"));
    expect(st.getByRole("combobox", { name: "Kind" })).toHaveTextContent("US states");
    expect(st.getByRole("combobox", { name: "Complete when you've worked" })).toHaveTextContent("All of these");
    expect(st.getByRole("button", { name: "All 50 states" })).toBeInTheDocument();
    expect(st.getByRole("combobox", { name: "Add a state" })).toHaveAttribute("placeholder", "Type a state or abbreviation");
    const pk = within(section("Parks"));
    expect(pk.getByRole("button", { name: "Cape Lookout National Seashore" })).toBeInTheDocument();
    expect(pk.getByRole("combobox", { name: "Add a park" })).toHaveAttribute("placeholder", "Search by name or reference");
    const bd = within(section("Bands"));
    expect(bd.getByRole("combobox", { name: "Complete when you've worked" })).toHaveTextContent("At least");
    expect(bd.getByRole("spinbutton", { name: "How many" })).toHaveValue(4);
    expect(bd.getByRole("button", { name: "80 m" })).toBeInTheDocument();
    expect(bd.getByText("Once you've worked 4 of these, the rest stop alerting.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete goal" })).toBeInTheDocument();
  });

  it("saves the list whole and opens its progress page", async () => {
    const { user, app } = edit();
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "2026 chase, again");
    await user.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(location()).toBe("/goals/n1"));
    expect(saved()).toEqual({
      id: "n1", name: "2026 chase, again", starts_on: "2026-01-01", ends_on: "2026-12-31", marking: "relay",
      requirements: [
        { id: "r-states", kind: "state", complete_when: "all", at_least: null, entries: states().entries.map((e) => e.value) },
        { id: "r-parks", kind: "park", complete_when: "all", at_least: null, entries: parks().entries.map((e) => e.value) },
        { id: "r-bands", kind: "band", complete_when: "at_least", at_least: 4, entries: ["80m", "40m", "20m", "15m", "10m", "6m"] },
      ],
    });
    expect(app.notify).toHaveBeenCalledWith("Saved changes");
  });

  it("shows a name error on the field and other errors as a toast", async () => {
    const { user, app } = edit();
    await screen.findByRole("heading", { level: 1, name: "Edit goal" });
    vi.mocked(saveGoal).mockRejectedValueOnce(new ApiError("You already have a goal with that name."));
    await user.click(screen.getByRole("button", { name: "Save goal" }));
    expect(await screen.findByText("You already have a goal with that name.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true");
    expect(app.notify).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " 2");
    expect(screen.queryByText("You already have a goal with that name.")).not.toBeInTheDocument();

    vi.mocked(saveGoal).mockRejectedValueOnce(new ApiError('"At least" must be smaller than the number of entries.'));
    await user.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith('"At least" must be smaller than the number of entries.'));
    expect(location()).toBe("/goals/n1/edit");
    expect(screen.getByRole("button", { name: "Save goal" })).toBeEnabled();
  });

  it("warns before a new start date sends contact marks back to needed", async () => {
    const pk = parks();
    pk.entries[1] = {
      ...pk.entries[1]!, worked_at: "2026-02-20T13:00:00Z",
      evidence: { worked_call: "N4DEF", contact_time: "2026-02-20T13:00:00Z", logger_app: "N1MM", matched_spot_time: null },
    };
    const { user } = edit(progress({ requirements: [states(), pk, bands()] }));
    const start = await screen.findByLabelText("Starts");
    await user.clear(start);
    await user.type(start, "2026-03-01");
    const window = within(section("Time window"));
    expect(window.getByText("1 worked entry falls before the new start date")).toBeInTheDocument();
    expect(window.getByText(/^Cape Lookout National Seashore was worked in February\. When you save, it goes back to needed/)).toBeInTheDocument();
    // Mar 1 is before the first contact, Oct 16: the notice stays.
    expect(screen.getByText("Long Lines only knows contacts since Oct 16, 2026")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(saved().starts_on).toBe("2026-03-01"));
  });

  it("switches to no end date and back, and to marking by hand", async () => {
    const { user } = edit();
    await screen.findByRole("heading", { level: 1, name: "Edit goal" });
    await choose(user, "Counts contacts", "No end date");
    expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
    await choose(user, "Counts contacts", "Between dates");
    expect(screen.getByLabelText("Starts")).toHaveValue("2026-01-01");
    await choose(user, "Counts contacts", "No end date");

    await choose(user, "Mark entries worked", "By hand only");
    const marking = within(section("How entries get marked"));
    expect(marking.getByText("Spots never mark an entry on their own.")).toBeInTheDocument();
    expect(marking.getByText("2 worked entries came from your log")).toBeInTheDocument();
    expect(screen.queryByText(/^Long Lines only knows contacts since/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(saved()).toMatchObject({ starts_on: null, ends_on: null, marking: "hand" }));
  });

  it("adds, changes and removes requirements", async () => {
    const { user } = edit(progress({ requirements: [states()] }));
    await screen.findByRole("region", { name: "States" });
    await user.click(screen.getByRole("button", { name: "Add requirement" }));
    expect(within(section("Parks")).getByRole("combobox", { name: "Kind" })).toHaveTextContent("Parks");

    await choose(user, "Kind", "Bands", section("Parks"));
    const bd = within(section("Bands"));
    expect(bd.getByRole("button", { name: "15 m" })).toBeInTheDocument();
    await choose(user, "Complete when you've worked", "At least", section("Bands"));
    expect(bd.getByRole("spinbutton", { name: "How many" })).toHaveValue(5);
    expect(bd.getByText("Once you've worked 5 of these, the rest stop alerting.")).toBeInTheDocument();
    await user.clear(bd.getByRole("spinbutton", { name: "How many" }));
    expect(bd.queryByText(/^Once you've worked/)).not.toBeInTheDocument();
    await user.type(bd.getByRole("spinbutton", { name: "How many" }), "3");

    await user.click(within(section("States")).getByRole("button", { name: "Delete requirement" }));
    expect(screen.queryByRole("region", { name: "States" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(saved().requirements).toEqual([
      { kind: "band", complete_when: "at_least", at_least: 3, entries: ["80m", "40m", "20m", "15m", "10m", "6m"] },
    ]));
  });

  it("adds and removes states by name or code, or all 50 at once", async () => {
    const { user } = edit(progress({ requirements: [states()] }));
    const st = within(await screen.findByRole("region", { name: "States" }));
    await user.click(within(st.getByRole("button", { name: "All 50 states" })).getByTestId("CancelIcon"));
    expect(st.queryByRole("button", { name: "All 50 states" })).not.toBeInTheDocument();

    const add = st.getByRole("combobox", { name: "Add a state" });
    await user.type(add, "north c");
    await user.click(await screen.findByRole("option", { name: /North Carolina/ }));
    expect(st.getByRole("button", { name: "NC" })).toBeInTheDocument();
    expect(add).toHaveValue("");
    await user.type(add, "ak");
    await user.click(await screen.findByRole("option", { name: /Alaska/ }));
    expect(st.getAllByRole("button").map((b) => b.textContent).filter((t) => t === "AK" || t === "NC")).toEqual(["AK", "NC"]);
    await user.click(within(st.getByRole("button", { name: "NC" })).getByTestId("CancelIcon"));
    expect(st.queryByRole("button", { name: "NC" })).not.toBeInTheDocument();

    await user.click(add);
    await user.click(await screen.findByRole("option", { name: "All 50 states" }));
    expect(st.getByRole("button", { name: "All 50 states" })).toBeInTheDocument();
  });

  it("adds bands from the band list", async () => {
    const { user } = edit(progress({ requirements: [bands()] }));
    const bd = within(await screen.findByRole("region", { name: "Bands" }));
    await user.click(bd.getByRole("combobox", { name: "Add a band" }));
    expect(screen.queryByRole("option", { name: "80 m" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "160 m" }));
    expect(bd.getAllByRole("button").map((b) => b.textContent).filter((t) => t?.endsWith(" m"))[0]).toBe("160 m");
  });

  it("searches POTA parks, and takes any typed reference", async () => {
    const { user } = edit(progress({ requirements: [parks()] }));
    const pk = within(await screen.findByRole("region", { name: "Parks" }));
    const add = pk.getByRole("combobox", { name: "Add a park" });
    await user.type(add, "mitchell");
    expect(await screen.findByText("Searching the lists…")).toBeInTheDocument();
    await advance(300);
    await user.click(await screen.findByRole("option", { name: /US-2741/ }));
    expect(searchReferences).toHaveBeenCalledWith("mitchell", "pota");
    expect(pk.getByRole("button", { name: "Mount Mitchell State Park" })).toBeInTheDocument();

    // Answered once: the same search again reads the cache.
    await user.type(add, "Mitchell");
    expect(await screen.findByRole("option", { name: /US-9000/ })).toBeInTheDocument();
    expect(screen.getByText("Retired")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /US-2741/ })).not.toBeInTheDocument();
    expect(searchReferences).toHaveBeenCalledTimes(1);
    // Text that isn't a reference stays in the field.
    await user.keyboard("{Enter}");
    expect(add).toHaveValue("Mitchell");

    await user.clear(add);
    vi.mocked(searchReferences).mockResolvedValueOnce({ results: [], more: false });
    await user.type(add, "us-12345");
    await advance(300);
    expect(await screen.findByText("Not in the POTA list. Press Enter to add it anyway.")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(pk.getByRole("button", { name: "US-12345" })).toBeInTheDocument();

    vi.mocked(searchReferences).mockResolvedValueOnce({ results: [], more: false });
    await user.type(add, "nowhere");
    await advance(300);
    expect(await screen.findByText("No parks match.")).toBeInTheDocument();
    await user.clear(add);

    vi.mocked(searchReferences).mockRejectedValueOnce(new Error("429"));
    await user.type(add, "broken");
    await advance(300);
    expect(await screen.findByText("Search is unavailable. Press Enter to add a reference.")).toBeInTheDocument();

    await user.click(within(pk.getByRole("button", { name: "Blue Ridge Parkway" })).getByTestId("CancelIcon"));
    await user.click(screen.getByRole("button", { name: "Save goal" }));
    await waitFor(() => expect(saved().requirements[0]!.entries).toEqual([
      "US-0001", "US-0002", "US-2763", "US-2764", "US-2765", "US-2766", "US-0004", "US-0005", "US-0006", "US-2741", "US-12345",
    ]));
  });

  it("cancels back to the progress page", async () => {
    const { user } = edit();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(location()).toBe("/goals/n1");
  });

  it("shows the blocked dialog while connections use the list", async () => {
    const { user } = edit();
    await user.click(await screen.findByRole("button", { name: "Delete goal" }));
    expect(screen.getByRole("dialog", { name: "Can't delete 2026 chase yet" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
  });

  it("deletes an unused list", async () => {
    const { user } = edit(progress({ used_by: [] }));
    await user.click(await screen.findByRole("button", { name: "Delete goal" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Delete/ }));
    await waitFor(() => expect(deleteGoal).toHaveBeenCalledWith("n1"));
    await waitFor(() => expect(location()).toBe("/goals"));
  });

  it("says when the list can't load", async () => {
    vi.mocked(loadGoal).mockRejectedValue(new ApiError("Couldn't load the goal."));
    renderPage(<GoalEditPage id="n1" />, { route: "/goals/n1/edit" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the goal.");
  });

  it("leaves the relay's status out for a list whose relay is quiet", async () => {
    edit(progress({ relay: { status: "stale", last_contact_at: "2026-10-20T00:00:00Z", logger_app: "N1MM", relay_count: 1 } }));
    expect(await screen.findByText(/^Choose "By hand only" if you don't log/)).toBeInTheDocument();
  });
});

describe("a new goal", () => {
  function add() {
    return renderPage(<GoalEditPage id={null} />, { route: "/goals/new" });
  }

  it("starts this year with all 50 states and saves once it has a name", async () => {
    vi.mocked(saveGoal).mockResolvedValue("n9");
    const { user, app } = add();
    expect(screen.getByRole("heading", { level: 1, name: "New goal" })).toBeInTheDocument();
    expect(loadGoal).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Starts")).toHaveValue("2026-01-01");
    expect(screen.getByRole("button", { name: "All 50 states" })).toBeInTheDocument();
    expect(screen.getByText(/^Choose "By hand only"/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete goal" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Long Lines only knows contacts since/)).not.toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save goal" });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "WAS 2026");
    await user.click(screen.getByRole("button", { name: "Add requirement" }));
    await user.click(save);
    await waitFor(() => expect(location()).toBe("/goals/n9"));
    const input = saved();
    expect("id" in input).toBe(false);
    expect(input.requirements.map((r) => r.kind)).toEqual(["state", "park"]);
    expect(app.notify).toHaveBeenCalledWith("Created WAS 2026");
  });

  it("cancels back to the index", async () => {
    const { user } = add();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe("/goals");
  });

  it("stops adding at ten requirements", async () => {
    const { user } = add();
    const button = screen.getByRole("button", { name: "Add requirement" });
    for (let i = 0; i < 9; i += 1) await user.click(button);
    expect(screen.getAllByRole("button", { name: "Delete requirement" })).toHaveLength(10);
    expect(button).toBeDisabled();
  });
});

describe("GoalEditPage on a phone", () => {
  beforeEach(() => setMobile(true));

  it("is a full-screen form with Save in the top bar", async () => {
    const { user } = edit();
    const dialog = await screen.findByRole("dialog", { name: "Edit goal" });
    const d = within(dialog);
    expect(d.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(d.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(d.getByRole("textbox", { name: "Name" })).toHaveValue("2026 chase");
    expect(d.getByRole("radio", { name: "Between dates" })).toBeChecked();
    expect(d.getByLabelText("Start")).toHaveValue("2026-01-01");
    expect(d.getByLabelText("End")).toHaveValue("2026-12-31");
    expect(d.getByRole("radio", { name: /From my log, using the relay/ })).toBeChecked();
    expect(d.getByText("You can still mark by hand")).toBeInTheDocument();
    expect(d.queryByRole("combobox", { name: "Kind" })).not.toBeInTheDocument();

    const pk = within(d.getByRole("region", { name: "Parks" }));
    expect(pk.getByRole("combobox", { name: "Complete when" })).toHaveTextContent("All of these");
    expect(pk.getByText("Entries")).toBeInTheDocument();
    expect(pk.getByRole("button", { name: "Great Smoky Mountains National Park" })).toBeInTheDocument();
    expect(pk.queryByRole("button", { name: "Pilot Mountain State Park" })).not.toBeInTheDocument();
    await user.click(pk.getByRole("button", { name: "+ 7 more" }));
    expect(pk.getByRole("button", { name: "Pilot Mountain State Park" })).toBeInTheDocument();
    expect(pk.queryByRole("combobox", { name: "Add a park" })).not.toBeInTheDocument();
    await user.click(pk.getByRole("button", { name: "Add parks" }));
    expect(pk.getByRole("combobox", { name: "Add a park" })).toHaveFocus();

    await user.click(within(d.getByRole("region", { name: "Bands" })).getByRole("button", { name: "Remove" }));
    expect(d.queryByRole("region", { name: "Bands" })).not.toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Add requirement" }));
    await user.click(await screen.findByRole("menuitem", { name: "Bands" }));
    expect(d.getByRole("region", { name: "Bands" })).toBeInTheDocument();

    await user.click(d.getByRole("radio", { name: "No end date" }));
    expect(d.queryByLabelText("Start")).not.toBeInTheDocument();
    await user.click(d.getByRole("radio", { name: "By hand only" }));
    expect(d.getByText("2 worked entries came from your log")).toBeInTheDocument();
    await user.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved()).toMatchObject({ starts_on: null, marking: "hand" }));
    expect(saved().requirements.map((r) => r.kind)).toEqual(["state", "park", "band"]);
  });

  it("goes back without saving, and offers Delete goal", async () => {
    const { user } = edit();
    const d = within(await screen.findByRole("dialog", { name: "Edit goal" }));
    expect(d.getByRole("button", { name: "Delete goal" })).toBeInTheDocument();
    await user.click(d.getByRole("radio", { name: "No end date" }));
    await user.click(d.getByRole("radio", { name: "Between dates" }));
    expect(d.getByLabelText("Start")).toHaveValue("2026-01-01");
    await user.click(d.getByRole("button", { name: "Back" }));
    expect(location()).toBe("/goals/n1");
    expect(saveGoal).not.toHaveBeenCalled();
  });

  it("caps long chip lists of states", async () => {
    const st = states();
    st.entries = st.entries.filter((e: GoalEntry) => e.value !== "AL");
    edit(progress({ list: card(), requirements: [st] }));
    const s = within(await screen.findByRole("region", { name: "States" }));
    expect(s.getByRole("button", { name: "+ 37 more" })).toBeInTheDocument();
  });
});
