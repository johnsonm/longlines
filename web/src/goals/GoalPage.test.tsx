import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { NOW, allWorked, bands, card, parks, progress, states } from "../test/goals";
import { ApiError, copyGoal, deleteGoal, loadGoal, markGoalEntry, resolveGoalReview } from "../lib/api";
import { RELAY_DOWNLOAD_URL } from "../tokens/model";
import { browserStorage, dismissKey } from "./model";
import { GoalPage } from "./GoalPage";
import type { GoalProgress, GoalReview } from "./types";

vi.mock("../lib/api", () => ({
  ApiError: class ApiError extends Error {
    code: string | undefined;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  },
  loadGoal: vi.fn(),
  markGoalEntry: vi.fn(),
  resolveGoalReview: vi.fn(),
  copyGoal: vi.fn(),
  deleteGoal: vi.fn(),
}));

beforeEach(() => {
  for (const fn of [loadGoal, markGoalEntry, resolveGoalReview, copyGoal, deleteGoal]) vi.mocked(fn).mockReset();
  vi.mocked(markGoalEntry).mockResolvedValue();
  vi.mocked(resolveGoalReview).mockResolvedValue();
  vi.mocked(deleteGoal).mockResolvedValue();
  setMobile(false);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function show(p: GoalProgress = progress()) {
  vi.mocked(loadGoal).mockResolvedValue(p);
  return renderPage(<GoalPage id={p.list.id} />, { route: `/goals/${p.list.id}` });
}

const section = (name: string) => screen.getByRole("region", { name });

const REVIEWS: GoalReview[] = [
  { id: "v1", worked_call: "AA1ZZ", band: "20m", mode: "cw", contact_time: "2026-10-27T20:44:00Z", candidates: [] },
  {
    id: "v2", worked_call: "W8XYZ", band: "40m", mode: "ssb", contact_time: "2026-10-26T15:10:00Z",
    candidates: [{ reference: "US-2763", name: "Hanging Rock State Park" }, { reference: "US-2764", name: "Pilot Mountain State Park" }],
  },
];

/** Bands done at 4 of 6: 80 m worked too, 10 m and 6 m left. */
function fourBands() {
  const b = bands({ complete: true, worked: 4 });
  b.entries[0] = { ...b.entries[0]!, worked_at: "2026-11-18T10:00:00Z", worked_how: "hand" };
  return b;
}

describe("GoalPage", () => {
  it("shows the list's requirements, progress, how entries get marked and the connections using it", async () => {
    show();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: "2026 chase" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Goals" })).toHaveAttribute("href", "/goals");
    expect(screen.getByRole("link", { name: "Edit goal" })).toHaveAttribute("href", "/goals/n1/edit");
    expect(screen.getByText("Counts contacts from Jan 1 – Dec 31, 2026 · 64 days left")).toBeInTheDocument();

    const st = within(section("States"));
    expect(st.getByText("· Work all 50")).toBeInTheDocument();
    expect(st.getByText("12 of 50 worked")).toBeInTheDocument();
    expect(st.getByText("Still needed · 38")).toBeInTheDocument();
    expect(st.getAllByRole("button").filter((b) => b.classList.contains("MuiChip-root"))).toHaveLength(38);
    expect(st.getByRole("button", { name: "AK" })).toBeInTheDocument();
    expect(st.getByRole("button", { name: "Show 12 worked" })).toBeInTheDocument();

    const pk = within(section("Parks"));
    expect(pk.getByRole("button", { name: "Hanging Rock State Park" })).toBeInTheDocument();
    const bd = within(section("Bands"));
    expect(bd.getByText("· Work at least 4 of 6")).toBeInTheDocument();
    expect(bd.getByText("3 of 4 worked")).toBeInTheDocument();
    expect(bd.getByText("Still needed · 3")).toBeInTheDocument();
    expect(bd.getByRole("button", { name: "80 m" })).toBeInTheDocument();
    expect(bd.getByText("Once you've worked 4, the other bands stop alerting too.")).toBeInTheDocument();

    const aside = within(screen.getByRole("complementary", { name: "Summary" }));
    expect(aside.getByText("18 of 64 worked")).toBeInTheDocument();
    expect(aside.getByText("0 of 3 requirements complete")).toBeInTheDocument();
    expect(aside.getByText("Long Lines relay")).toBeInTheDocument();
    expect(aside.getByText("Connected")).toBeInTheDocument();
    expect(aside.getByText("N1MM · Last contact 12 minutes ago")).toBeInTheDocument();
    expect(aside.getByText(/^When you log a contact, Long Lines checks it against your entries\./)).toBeInTheDocument();
    expect(aside.getByText(/^A spot alone never marks anything worked\./)).toBeInTheDocument();
    const used = within(section("Used by"));
    expect(used.getByRole("link", { name: "POTA states, CW" })).toHaveAttribute("href", "/connections/s1");
    expect(used.getByText("Parks on the Air · 1 destination")).toBeInTheDocument();
    expect(used.getByText("DX Cluster · 2 destinations")).toBeInTheDocument();
    expect(used.getByText("Every connection using this goal stops alerting for entries you've worked.")).toBeInTheDocument();

    expect(screen.queryByText("Entries aren't being marked automatically")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs a look" })).not.toBeInTheDocument();
  });

  it("shows worked entries with how they got marked, hides them again, and sets one back to needed", async () => {
    const { user } = show();
    await screen.findByRole("heading", { level: 1, name: "2026 chase" });
    const pk = within(section("Parks"));
    await user.click(pk.getByRole("button", { name: "Show 3 worked" }));
    expect(pk.getByText("Worked · 3")).toBeInTheDocument();
    expect(pk.getByText("Great Smoky Mountains National Park")).toBeInTheDocument();
    expect(pk.getByText("Worked K4ABC · Oct 3, 21:14 UTC · Logged in N1MM, matched to a POTA spot at 21:09")).toBeInTheDocument();
    expect(pk.getByText("Worked N4DEF · Oct 12, 14:02 UTC · Logged in N1MM, matched to a POTA spot at 13:58")).toBeInTheDocument();
    expect(pk.getByText("Marked by hand · Oct 20")).toBeInTheDocument();
    expect(pk.getAllByTestId("CheckIcon")).toHaveLength(3);

    await user.click(pk.getByRole("button", { name: "Mark Blue Ridge Parkway as needed" }));
    expect(markGoalEntry).toHaveBeenCalledWith("r-parks", "US-0003", false);
    await waitFor(() => expect(loadGoal).toHaveBeenCalledTimes(2));

    await user.click(pk.getByRole("button", { name: "Hide worked" }));
    expect(pk.queryByText("Worked · 3")).not.toBeInTheDocument();
    expect(pk.getByRole("button", { name: "Show 3 worked" })).toBeInTheDocument();
  });

  it("marks a still-needed entry worked by hand from its chip", async () => {
    const { user } = show();
    await screen.findByRole("heading", { level: 1, name: "2026 chase" });
    await user.click(within(section("States")).getByRole("button", { name: "AK" }));
    const item = await screen.findByRole("menuitem", { name: /Mark as worked/ });
    expect(item).toHaveTextContent("Alaska");
    await user.click(item);
    expect(markGoalEntry).toHaveBeenCalledWith("r-states", "AK", true);
    await waitFor(() => expect(loadGoal).toHaveBeenCalledTimes(2));
  });

  it("reports a failed change and keeps the page", async () => {
    vi.mocked(markGoalEntry).mockRejectedValue(new Error("Not on this goal: AK."));
    const { user, app } = show();
    await screen.findByRole("heading", { level: 1, name: "2026 chase" });
    await user.click(within(section("States")).getByRole("button", { name: "AK" }));
    await user.click(await screen.findByRole("menuitem", { name: /Mark as worked/ }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Not on this goal: AK."));
    expect(loadGoal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { level: 1, name: "2026 chase" })).toBeInTheDocument();
  });

  it("asks the relay to be opened when it hasn't sent a contact in a while, and dismisses for 7 days", async () => {
    const stale = progress({ relay: { status: "stale", last_contact_at: "2026-10-20T10:00:00Z", logger_app: "N1MM", relay_count: 1 } });
    const { user, unmount } = show(stale);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Entries aren't being marked automatically");
    expect(banner).toHaveTextContent(/The relay hasn't sent a contact in 9 days\. Contacts you log while it's off won't mark anything worked/);
    const download = within(banner).getByRole("link", { name: "Download the relay" });
    expect(download).toHaveAttribute("href", RELAY_DOWNLOAD_URL);
    expect(download).toHaveAttribute("target", "_blank");

    const aside = within(screen.getByRole("complementary", { name: "Summary" }));
    expect(aside.getByText("Not connected")).toBeInTheDocument();
    expect(aside.getByText("Last contact Oct 20, 9 days ago")).toBeInTheDocument();
    expect(aside.getByText(/^While the relay is off, contacts you log don't reach Long Lines/)).toBeInTheDocument();
    expect(aside.getByRole("link", { name: "Download the relay" })).toHaveAttribute("href", RELAY_DOWNLOAD_URL);

    await user.click(within(banner).getByRole("button", { name: "Dismiss for 7 days" }));
    expect(screen.queryByText("Entries aren't being marked automatically")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(dismissKey("n1"))).toBe(String(NOW.getTime() + 7 * 86_400_000));
    unmount();

    show(stale);
    await screen.findByRole("heading", { level: 1, name: "2026 chase" });
    expect(screen.queryByText("Entries aren't being marked automatically")).not.toBeInTheDocument();
  });

  it("shows the relay banner where localStorage can't be read", async () => {
    const spy = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(browserStorage()).toBeNull();
    const { user } = show(progress({ relay: { status: "never", last_contact_at: null, logger_app: null, relay_count: 0 } }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("The relay hasn't sent a contact yet.");
    expect(screen.getByText("No contacts yet")).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: "Dismiss for 7 days" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it("says a list marked by hand doesn't use the relay", async () => {
    show(progress({ list: card({ marking: "hand" }), relay: { status: "never", last_contact_at: null, logger_app: null, relay_count: 0 } }));
    await screen.findByRole("heading", { level: 1, name: "2026 chase" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("You mark entries on this goal by hand. Contacts you log don't mark anything on it.")).toBeInTheDocument();
    expect(screen.queryByText("Long Lines relay")).not.toBeInTheDocument();
  });

  it("lists contacts that need a look, and picks, chooses or rules out a park", async () => {
    const { user } = show(progress({ reviews: REVIEWS }));
    const banner = await screen.findByText("2 logged contacts need a look before they can count toward Parks.");
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await user.click(within(banner.closest(".MuiAlert-root") as HTMLElement).getByRole("button", { name: "Review" }));
    expect(scroll).toHaveBeenCalled();

    const look = within(section("Needs a look"));
    expect(look.getByText("Needs a look · 2")).toBeInTheDocument();
    expect(look.getByText("Contacts we couldn't match to a park")).toBeInTheDocument();
    expect(look.getByText("AA1ZZ · 20 m CW")).toBeInTheDocument();
    expect(look.getByText("Oct 27, 20:44 UTC · No POTA spot for this station within 30 minutes of when you logged it.")).toBeInTheDocument();
    expect(look.getByText("W8XYZ · 40 m SSB")).toBeInTheDocument();
    expect(look.getByText(/Spotted at two different parks around then: Hanging Rock State Park and Pilot Mountain State Park\.$/)).toBeInTheDocument();
    expect(screen.getByText("Why this happens")).toBeInTheDocument();
    expect(screen.getByText("States and bands never need a look. They come straight from the contact.")).toBeInTheDocument();

    // No spot near the contact: Pick park offers the parks still needed.
    await user.click(look.getByRole("button", { name: "Pick park" }));
    expect(await screen.findAllByRole("menuitem")).toHaveLength(7);
    await user.click(screen.getByRole("menuitem", { name: /Fort Macon State Park/ }));
    expect(resolveGoalReview).toHaveBeenCalledWith("v1", "US-2766");

    // Spots at two parks: Choose park offers those two.
    await waitFor(() => expect(look.getByRole("button", { name: "Choose park" })).toBeEnabled());
    await user.click(look.getByRole("button", { name: "Choose park" }));
    const options = await screen.findAllByRole("menuitem");
    expect(options.map((o) => o.textContent)).toEqual(["Hanging Rock State ParkUS-2763", "Pilot Mountain State ParkUS-2764"]);
    await user.click(options[1]!);
    expect(resolveGoalReview).toHaveBeenLastCalledWith("v2", "US-2764");

    await waitFor(() => expect(look.getAllByRole("button", { name: "Not a park contact" })[0]).toBeEnabled());
    await user.click(look.getAllByRole("button", { name: "Not a park contact" })[0]!);
    expect(resolveGoalReview).toHaveBeenLastCalledWith("v1", null);
    await waitFor(() => expect(loadGoal).toHaveBeenCalledTimes(4));
  });

  it("celebrates a complete list, says the rule is off, and offers Review connections and Delete", async () => {
    const done = progress({
      list: card({ status: "complete", completed_at: "2026-11-18T10:00:00Z", worked: 64 }),
      requirements: [allWorked(states()), allWorked(parks()), fourBands()],
    });
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const { user } = show(done);
    expect(await screen.findByText("Complete")).toBeInTheDocument();
    expect(screen.getByText("Counts contacts from Jan 1 – Dec 31, 2026 · Finished Nov 18, 43 days early")).toBeInTheDocument();
    expect(screen.getByText("You worked everything on this goal")).toBeInTheDocument();
    expect(screen.getByText("All 3 requirements are complete. Nice work.")).toBeInTheDocument();
    expect(screen.getByText("The goal rule is now off on 2 connections")).toBeInTheDocument();
    expect(screen.getByText(/^POTA states, CW and DX states no longer filter by this goal/)).toBeInTheDocument();
    expect(within(section("States")).getByText("Done")).toBeInTheDocument();
    expect(within(section("Bands")).getByRole("button", { name: "Show 4 worked" })).toBeInTheDocument();
    expect(within(section("States")).queryByText(/Still needed/)).not.toBeInTheDocument();
    expect(screen.getByText("3 of 3 requirements complete")).toBeInTheDocument();
    expect(screen.getByText("The goal rule is off on both connections.")).toBeInTheDocument();
    expect(screen.queryByText("How entries get marked")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete goal" }));
    const dialog = await screen.findByRole("dialog", { name: "Can't delete 2026 chase yet" });
    expect(dialog).toHaveTextContent("2 connections use this goal. Remove the goal rule from each one, then you can delete it.");
    expect(within(dialog).getByText("Parks on the Air · 1 destination")).toBeInTheDocument();
    const open = within(dialog).getByRole("link", { name: "Open POTA states, CW" });
    expect(open).toHaveAttribute("href", "/connections/s1");
    expect(open).toHaveAttribute("target", "_blank");
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(deleteGoal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Review connections" }));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/connections$/);
  });

  it("deletes a complete list no connection uses after confirming", async () => {
    const done = progress({
      list: card({ status: "complete", completed_at: "2026-10-28T10:00:00Z", worked: 64, connection_count: 0 }),
      requirements: [allWorked(states())], used_by: [],
    });
    const { user, app } = show(done);
    expect(await screen.findByText("The requirement is complete. Nice work.")).toBeInTheDocument();
    expect(screen.queryByText(/The goal rule is now off/)).not.toBeInTheDocument();
    expect(screen.getByText("Not used by any connection")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete goal" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete 2026 chase?" });
    expect(dialog).toHaveTextContent("Its entries and what you've worked go with it.");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(deleteGoal).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Deleted 2026 chase"));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/goals$/);
  });

  it("shows the connections that started using the list when SQL refuses the delete", async () => {
    const lonely = progress({ list: card({ status: "complete", completed_at: "2026-10-28T10:00:00Z" }), used_by: [] });
    vi.mocked(deleteGoal).mockRejectedValue(new ApiError("Remove it from its connections first.", "LL409"));
    const { user } = show(lonely);
    await screen.findByText("You worked everything on this goal");
    vi.mocked(loadGoal).mockResolvedValue(progress({ list: lonely.list }));
    await user.click(screen.getByRole("button", { name: "Delete goal" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("dialog", { name: "Can't delete 2026 chase yet" })).toHaveTextContent("POTA states, CW");
  });

  it("reports any other failed delete", async () => {
    vi.mocked(deleteGoal).mockRejectedValue(new Error("offline"));
    const { user, app } = show(progress({ list: card({ status: "ended" }), used_by: [] }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("offline"));
  });

  it("says an ended list stopped counting, and offers Change dates, Copy for next year and Delete", async () => {
    vi.setSystemTime(new Date("2027-01-03T12:00:00Z"));
    vi.mocked(copyGoal).mockResolvedValue("n9");
    const { user } = show(progress({ list: card({ status: "ended" }) }));
    expect(await screen.findByText("Ended")).toBeInTheDocument();
    expect(screen.getByText("Counted contacts from Jan 1 – Dec 31, 2026 · Ended 3 days ago")).toBeInTheDocument();
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("This goal ended Dec 31, 2026");
    expect(banner).toHaveTextContent(/^This goal ended Dec 31, 202646 entries were still needed\./);
    expect(within(section("States")).getByText("Not worked · 38")).toBeInTheDocument();
    expect(within(section("Bands")).queryByText(/Once you've worked/)).not.toBeInTheDocument();
    expect(screen.getByText("Final: 0 of 3 requirements complete")).toBeInTheDocument();
    expect(screen.getByText("The goal rule is off on both connections while this goal is ended.")).toBeInTheDocument();

    await user.click(within(banner).getByRole("button", { name: "Copy for 2027" }));
    expect(copyGoal).toHaveBeenCalledWith("n1");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/goals/n9/edit"));
  });

  it("opens the edit page from Change dates, and reports a failed copy", async () => {
    vi.setSystemTime(new Date("2027-01-03T12:00:00Z"));
    vi.mocked(copyGoal).mockRejectedValue(new Error("You can have up to 50 goals."));
    const { user, app } = show(progress({ list: card({ status: "ended" }) }));
    const banner = await screen.findByRole("alert");
    await user.click(within(banner).getByRole("button", { name: "Copy for 2027" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("You can have up to 50 goals."));
    await user.click(within(banner).getByRole("button", { name: "Change dates" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/goals/n1/edit");
  });

  it("shows a failed load in place of the page", async () => {
    vi.mocked(loadGoal).mockRejectedValue(new Error("Goal not found."));
    renderPage(<GoalPage id="nope" />, { route: "/goals/nope" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Goal not found.");
  });

  it("keeps the page and shows the error when a reload fails", async () => {
    const { user } = show();
    await screen.findByRole("heading", { level: 1, name: "2026 chase" });
    vi.mocked(loadGoal).mockRejectedValue(new Error(""));
    await user.click(within(section("States")).getByRole("button", { name: "AK" }));
    await user.click(await screen.findByRole("menuitem", { name: /Mark as worked/ }));
    expect(await screen.findByText("Couldn't load the goal.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "2026 chase" })).toBeInTheDocument();
  });

  describe("on a phone", () => {
    beforeEach(() => setMobile(true));

    it("puts progress and the relay first, shows 12 chips (4 parks) then Show all, and folds How entries get marked", async () => {
      const { user } = show();
      expect(await screen.findByRole("heading", { level: 1, name: "2026 chase" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/goals");
      expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/goals/n1/edit");
      expect(screen.queryByRole("link", { name: "Goals" })).not.toBeInTheDocument();
      expect(screen.getByText("Jan 1 – Dec 31, 2026 · 64 days left")).toBeInTheDocument();
      expect(screen.getByText("Relay")).toBeInTheDocument();
      expect(screen.getByText("Last contact 12 minutes ago")).toBeInTheDocument();
      expect(screen.queryByRole("complementary")).not.toBeInTheDocument();

      const st = within(section("States"));
      expect(st.getByText("12 of 50")).toBeInTheDocument();
      expect(st.getAllByRole("button").filter((b) => b.classList.contains("MuiChip-root"))).toHaveLength(12);
      await user.click(st.getByRole("button", { name: "Show all 38 needed" }));
      expect(st.getAllByRole("button").filter((b) => b.classList.contains("MuiChip-root"))).toHaveLength(38);
      expect(st.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
      expect(within(section("Bands")).getByText("· At least 4 of 6")).toBeInTheDocument();

      // Parks show four chips, as the canvas's phone frame draws them.
      const pk = within(section("Parks"));
      const parkChips = () => pk.getAllByRole("button").filter((b) => b.classList.contains("MuiChip-root")).map((b) => b.textContent);
      expect(parkChips()).toEqual([
        "Hanging Rock State Park", "Pilot Mountain State Park", "Jordan Lake State Recreation Area", "Fort Macon State Park",
      ]);
      await user.click(pk.getByRole("button", { name: "Show all 7 needed" }));
      expect(parkChips()).toHaveLength(7);
      expect(pk.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
      await user.click(pk.getByRole("button", { name: "Show 3 worked" }));
      expect(pk.getByText("K4ABC · Oct 3, 21:14 UTC · Matched to a POTA spot at 21:09")).toBeInTheDocument();

      const how = screen.getByRole("button", { name: "How entries get marked" });
      expect(how).toHaveAttribute("aria-expanded", "false");
      await user.click(how);
      expect(how).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(/^When you log a contact, Long Lines checks it against your entries\./)).toBeInTheDocument();
      expect(within(section("Used by")).getByText("DX Cluster · 2 destinations")).toBeInTheDocument();
      expect(screen.queryByText(/stops alerting for entries you've worked/)).not.toBeInTheDocument();
    });

    it("folds the relay's off state and a hand-marked list's note too", async () => {
      const { unmount } = show(progress({ relay: { status: "stale", last_contact_at: "2026-10-20T10:00:00Z", logger_app: null, relay_count: 1 } }));
      await screen.findByRole("heading", { level: 1, name: "2026 chase" });
      expect(screen.getByText("Not connected")).toBeInTheDocument();
      expect(screen.getByText(/^While the relay is off/)).toBeInTheDocument();
      unmount();
      show(progress({ list: card({ marking: "hand" }) }));
      await screen.findByRole("heading", { level: 1, name: "2026 chase" });
      expect(screen.queryByText("Relay")).not.toBeInTheDocument();
      expect(screen.getByText(/^You mark entries on this goal by hand\./)).toBeInTheDocument();
    });

    it("says Show all not worked on an ended list", async () => {
      vi.setSystemTime(new Date("2027-01-03T12:00:00Z"));
      show(progress({ list: card({ status: "ended" }) }));
      await screen.findByText("Ended");
      expect(within(section("States")).getByRole("button", { name: "Show all 38 not worked" })).toBeInTheDocument();
    });
  });
});
