import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { loadHomeFlow, loadLatestStats, type Destination, type SubscriptionWithLinks } from "../lib/api";
import { HomePage } from "./HomePage";
import type { HomeFlow } from "./types";

vi.mock("../lib/api", () => ({ loadHomeFlow: vi.fn(), loadLatestStats: vi.fn() }));

const dest = (id: string, name: string, type: string) => ({ id, name, type, enabled: true }) as Destination;
const sub = (id: string, name: string, destinations: string[]) => ({ id, name, enabled: true, destinations, sources: [] as string[] }) as SubscriptionWithLinks;

const DESTS = [dest("d1", "RARS Discord", "discord"), dest("d2", "Logger", "webhook")];
const SUBS = [sub("s1", "POTA Carolinas", ["d1", "d2"]), sub("s2", "DX 20m CW", ["d2"]), sub("s3", "All POTA", [])];
const FLOW: HomeFlow = {
  matched: 650,
  delivered: 311,
  sources: [{ source: "dxcluster", matched: 37 }, { source: "pota", matched: 86 }],
  subscriptions: [
    { subscription_id: "s1", source: "pota", matched: 86 },
    { subscription_id: "s2", source: "dxcluster", matched: 37 },
  ],
  links: [
    { subscription_id: "s1", destination_id: "d1", delivered: 131 },
    { subscription_id: "s1", destination_id: "d2", delivered: 12 },
    { subscription_id: "s2", destination_id: "d2", delivered: 37 },
  ],
  subscription_sources: [
    { subscription_id: "s1", source: "pota" },
    { subscription_id: "s2", source: "dxcluster" },
    { subscription_id: "s3", source: "pota" },
  ],
};

beforeEach(() => {
  setMobile(false);
  vi.mocked(loadHomeFlow).mockReset().mockResolvedValue(FLOW);
  vi.mocked(loadLatestStats).mockReset().mockResolvedValue(null);
});

function render(subs = SUBS, dests = DESTS, loading = false) {
  return renderPage(<HomePage subs={subs} dests={dests} loading={loading} />, { route: "/home" });
}

const link = (name: RegExp) => screen.getByRole("link", { name });
const diagramPaths = (container: HTMLElement) => [...container.querySelectorAll("svg[preserveAspectRatio='none'] path")];

describe("HomePage on desktop", () => {
  it("shows the last 24 hours in two stat cards", async () => {
    render();
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(await screen.findByText("311")).toBeInTheDocument();
    expect(screen.getByText("650")).toBeInTheDocument();
    expect(screen.getByText("spots sent to your destinations · last 24 hours")).toBeInTheDocument();
    expect(screen.getByText("spots your connections picked up · last 24 hours")).toBeInTheDocument();
  });

  it("draws sources, connections and destinations as linked nodes", async () => {
    const { container } = render();
    await screen.findByText("311");
    expect(screen.getByRole("heading", { level: 2, name: "How your spots flow" })).toBeInTheDocument();
    expect(screen.getByText("Last 24 hours. Line width shows how many spots matched.")).toBeInTheDocument();

    expect(link(/^POTA 86 matched$/)).toHaveAttribute("href", "/sources/pota");
    expect(link(/^DX Cluster 37 matched$/)).toHaveAttribute("href", "/sources/dxcluster");
    expect(link(/^POTA Carolinas 86 matched · 2 destinations$/)).toHaveAttribute("href", "/connections/s1");
    expect(link(/^DX 20m CW 37 matched · 1 destination$/)).toHaveAttribute("href", "/connections/s2");
    // No destination, so the matcher skips it and nothing was recorded.
    expect(link(/^All POTA – matched · No destination$/)).toHaveAttribute("href", "/connections/s3");
    expect(link(/^RARS Discord Discord · 131 delivered$/)).toHaveAttribute("href", "/destinations/d1");
    expect(link(/^Logger Webhook · 49 delivered$/)).toHaveAttribute("href", "/destinations/d2");

    // Three source links (All POTA's too, though it matched nothing) and three destination links,
    // in the source's colour at 0.45, true-pixel strokes.
    const paths = diagramPaths(container);
    expect(paths).toHaveLength(6);
    for (const p of paths) {
      expect(p.getAttribute("d")).toMatch(/^M0 [\d.]+ C50 [\d.]+ 50 [\d.]+ 100 [\d.]+$/);
      expect(p).toHaveAttribute("vector-effect", "non-scaling-stroke");
      expect(p).toHaveAttribute("stroke-opacity", "0.45");
    }
    expect(paths[0]).toHaveAttribute("stroke", "#1976d2");
    expect(container.querySelector("svg[preserveAspectRatio='none']")).toHaveAttribute("viewBox", expect.stringMatching(/^0 0 100 \d+$/));
  });

  it("draws the whole configuration when nothing has flowed", async () => {
    vi.mocked(loadHomeFlow).mockResolvedValue({ ...FLOW, matched: 0, delivered: 0, sources: [], subscriptions: [], links: [] });
    const { container } = render(SUBS, [...DESTS, dest("d3", "Spare", "push")]);
    expect(await screen.findAllByText("0")).toHaveLength(2);
    expect(link(/^POTA 0 matched$/)).toHaveAttribute("href", "/sources/pota");
    expect(link(/^DX Cluster 0 matched$/)).toBeInTheDocument();
    expect(link(/^POTA Carolinas 0 matched · 2 destinations$/)).toBeInTheDocument();
    expect(link(/^Spare Push · 0 delivered$/)).toHaveAttribute("href", "/destinations/d3");
    // Every configured link, at the 2 px floor; the spare destination has none.
    const paths = diagramPaths(container);
    expect(paths).toHaveLength(6);
    for (const p of paths) expect(p).toHaveAttribute("stroke-width", "2");
  });

  it("shows every connection, with no cap", async () => {
    const subs = Array.from({ length: 10 }, (_, i) => sub(`c${i}`, `Conn ${i}`, ["d1"]));
    vi.mocked(loadHomeFlow).mockResolvedValue({
      ...FLOW,
      subscriptions: subs.slice(0, 3).map((s, i) => ({ subscription_id: s.id, source: "pota", matched: 10 - i })),
      links: [],
      subscription_sources: subs.map((s) => ({ subscription_id: s.id, source: "pota" })),
    });
    render(subs);
    expect(await screen.findByText("Last 24 hours. Line width shows how many spots matched.")).toBeInTheDocument();
    for (const s of subs) expect(link(new RegExp(`^${s.name} `))).toHaveAttribute("href", `/connections/${s.id}`);
    expect(screen.queryByText(/more connection/)).not.toBeInTheDocument();
  });

  it("shows en dashes and toasts when the counts don't load", async () => {
    vi.mocked(loadHomeFlow).mockRejectedValue(new Error("Nope."));
    const { app } = render();
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Nope."));
    expect(screen.getAllByText("–")).toHaveLength(2);
    expect(link(/^POTA Carolinas – matched · 2 destinations$/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows progress at the top of the card while loading, and no empty state", () => {
    vi.mocked(loadHomeFlow).mockReturnValue(new Promise(() => {}));
    render([], [], true);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText("No connections or destinations yet.")).not.toBeInTheDocument();
    expect(screen.getAllByText("–")).toHaveLength(2);
  });
});

describe("HomePage on a phone", () => {
  it("lists destinations instead of the diagram", async () => {
    setMobile(true);
    const { container } = render();
    await screen.findByText("311");
    expect(diagramPaths(container)).toHaveLength(0);
    expect(screen.getByText("Last 24 hours, by destination.")).toBeInTheDocument();
    expect(screen.getAllByText("last 24 hours")).toHaveLength(2);
    const names = screen.getAllByRole("link").map((a) => a.textContent);
    expect(names).toEqual(["RARS DiscordDiscord · 131 delivered", "LoggerWebhook · 49 delivered", "View all connections"]);
    expect(link(/^View all connections$/)).toHaveAttribute("href", "/connections");
  });
});

describe("HomePage empty states", () => {
  it("offers a first connection when there are none", async () => {
    const { user } = render([], []);
    expect(screen.getByText("No connections or destinations yet.")).toBeInTheDocument();
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add your first connection" }));
    const dialog = await screen.findByRole("dialog", { name: "New connection" });
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("location")).toHaveAttribute("data-search", "?source=pota");
    expect(screen.getByTestId("location")).toHaveTextContent("/connections/new");
  });

  it("keeps the stat cards and offers a first destination when connections have nowhere to go", async () => {
    vi.mocked(loadHomeFlow).mockResolvedValue({ ...FLOW, delivered: 0, matched: 0 });
    const { user } = render(SUBS, []);
    expect(await screen.findAllByText("0")).toHaveLength(2);
    expect(screen.getByText("Your connections have nowhere to send spots yet.")).toBeInTheDocument();
    expect(screen.queryByText("How your spots flow")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add your first destination" }));
    expect(await screen.findByRole("dialog", { name: "Add destination" })).toBeInTheDocument();
  });
});
