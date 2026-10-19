import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { GroupStatistics } from "./GroupStatistics";
import { redacted, STATS } from "./stats/fixtures";
import type { GroupStatistics as Stats } from "./stats/types";

vi.mock("../stats/useStats", () => ({ useStats: () => ({ stats: null, loading: false, error: null }) }));

const NOW = new Date("2026-10-19T15:00:00Z");

beforeEach(() => setMobile(false));

function render(stats: Stats = STATS) {
  const onPeriod = vi.fn();
  return { ...renderPage(<GroupStatistics stats={stats} period={stats.period} onPeriod={onPeriod} now={NOW} />), onPeriod };
}

// The first match: "Spots heard" is the KPI and also the CW and SSB cards' subtitle.
const card = (title: string) => screen.getAllByText(title)[0]!.closest(".MuiCard-root") as HTMLElement;

describe("GroupStatistics", () => {
  it("shows when it was built and switches the period", async () => {
    const { user, onPeriod } = render();
    expect(screen.getByText("Updated 12 minutes ago. Statistics refresh every hour.")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Period" }));
    await user.click(await screen.findByRole("option", { name: "Last 7 days" }));
    expect(onPeriod).toHaveBeenCalledWith("7d");
  });

  it("shows the four figures with their lines", () => {
    render();
    expect(within(card("Spots heard")).getByText("10,082")).toBeInTheDocument();
    expect(within(card("Spots heard")).getByText("12% more than the previous 30 days")).toBeInTheDocument();
    expect(within(card("Active members")).getByText("11 of 12")).toBeInTheDocument();
    expect(within(card("Active members")).getByText("Heard at least once")).toBeInTheDocument();
    expect(within(card("Activations")).getByText("31")).toBeInTheDocument();
    expect(within(card("Activations")).getByText("26 POTA, 5 SOTA")).toBeInTheDocument();
    expect(within(card("Places activated")).getByText("22")).toBeInTheDocument();
    expect(within(card("Places activated")).getByText("19 parks, 3 summits")).toBeInTheDocument();
  });

  it("lists who is most active, with days out of the period and an empty list", () => {
    render();
    expect(screen.getByRole("heading", { name: "Who is most active" })).toBeInTheDocument();
    const most = card("Most spots");
    expect(within(most).getByText("All modes and sources")).toBeInTheDocument();
    expect(within(most).getByRole("link", { name: "KK4PWJ" })).toHaveAttribute("href", "/call/KK4PWJ");
    expect(within(most).getByText("2,591")).toBeInTheDocument();
    expect(within(card("Most days on the air")).getByText("17 of 30")).toBeInTheDocument();
    expect(within(card("Digital")).getByText("FT8 and FT4 spots heard")).toBeInTheDocument();
    expect(within(card("POTA activations")).getByText("Nobody yet")).toBeInTheDocument();
  });

  it("ranks members, shows ten, then all, and searches", async () => {
    const { user } = render();
    const members = card("Members");
    expect(within(members).getByText("Ranked by spots heard in the period. 11 of 12 members were heard.")).toBeInTheDocument();
    expect(within(members).getAllByRole("row")).toHaveLength(11);
    expect(within(members).getByText("Main mode")).toBeInTheDocument();
    expect(within(members).getAllByText("FT8 and FT4")).toHaveLength(2);
    expect(within(members).getAllByText("14 min ago").length).toBeGreaterThan(0);
    expect(within(members).getByText("9 days ago")).toBeInTheDocument();
    await user.click(within(members).getByRole("button", { name: "Show all 12 members" }));
    expect(within(members).getAllByRole("row")).toHaveLength(13);
    expect(within(members).getByText("Not heard yet")).toBeInTheDocument();
    expect(within(members).queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
    await user.type(within(members).getByRole("textbox", { name: "Search members" }), "k4d");
    const rows = within(members).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getByText("4")).toBeInTheDocument();
  });

  it("shows bands, modes and places", () => {
    render();
    expect(screen.getByText("Club spots by band")).toBeInTheDocument();
    expect(screen.getByText("Club spots by mode")).toBeInTheDocument();
    const places = card("Most activated places");
    expect(within(places).getByText("Falls Lake SRA")).toBeInTheDocument();
    expect(within(places).getByText("KK4PWJ, W4ABC")).toBeInTheDocument();
    expect(within(places).getByText("By")).toBeInTheDocument();
  });

  it("drops what SQL left out of a page without callsigns", () => {
    render(redacted(STATS));
    expect(screen.queryByText("Who is most active")).not.toBeInTheDocument();
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(within(card("Most activated places")).queryByText("By")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "KK4PWJ" })).not.toBeInTheDocument();
  });

  it("says when there were no activations", () => {
    render({ ...STATS, places: [] });
    expect(screen.getByText("No activations in the period")).toBeInTheDocument();
  });

  it("drops Main mode and By on phones", () => {
    setMobile(true);
    render();
    expect(within(card("Members")).queryByText("Main mode")).not.toBeInTheDocument();
    expect(within(card("Most activated places")).queryByText("By")).not.toBeInTheDocument();
  });
});
