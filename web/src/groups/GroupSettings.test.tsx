import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { deleteGroup, listGroups, loadSubscriptions, normalizeCallsigns, saveGroup, type SubscriptionWithLinks } from "../lib/api";
import { GroupSettings } from "./GroupSettings";
import { OWNER } from "./stats/fixtures";
import type { OwnerGroup } from "./stats/types";
import type { CallsignGroup } from "./types";

vi.mock("../lib/api", () => ({
  deleteGroup: vi.fn(),
  listGroups: vi.fn(),
  loadSubscriptions: vi.fn(),
  normalizeCallsigns: vi.fn(),
  saveGroup: vi.fn(),
}));

const ROW: CallsignGroup = {
  id: "g1", name: "Piedmont ARC", callsigns: ["K4DEF", "KK4PWJ", "W4ABC"], member_count: 3, subscription_count: 2,
  updated_at: "x", on_air: { count: 0, latest: null },
};

const sub = (name: string, group_ids: string[], sources: string[]) =>
  ({ id: name, name, group_ids, sources, rules: [] }) as unknown as SubscriptionWithLinks;

beforeEach(() => {
  for (const fn of [deleteGroup, listGroups, loadSubscriptions, saveGroup]) vi.mocked(fn).mockReset();
  vi.mocked(listGroups).mockResolvedValue([ROW]);
  vi.mocked(loadSubscriptions).mockResolvedValue([
    sub("POTA states I still need", ["g1"], ["pota"]), sub("Other", ["g2"], []), sub("Piedmont club on the air", ["g1"], ["pota"]),
  ]);
});

function render(group: Partial<OwnerGroup> = {}) {
  const onSaved = vi.fn(() => Promise.resolve());
  return { ...renderPage(<GroupSettings group={{ ...OWNER.group, ...group }} onSaved={onSaved} />, { route: "/groups/g1/settings" }), onSaved };
}

const publicSwitch = () => screen.getByRole("switch", { name: "Public statistics page" });

describe("GroupSettings", () => {
  it("shows a public page with its link and the callsigns switch", async () => {
    render();
    expect(await screen.findByText(/Anyone with the link can see this page, without signing in\./)).toBeInTheDocument();
    expect(publicSwitch()).toBeChecked();
    expect(screen.getByText(`${window.location.host}/g/7f3kq9xm2a`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open page" })).toHaveAttribute("href", "/g/7f3kq9xm2a");
    expect(screen.getByRole("switch", { name: "Show callsigns" })).toBeChecked();
    expect(screen.getByText("Off shows club totals only. Rankings and top operators are hidden.")).toBeInTheDocument();
    expect(screen.getByText(/The link is not listed anywhere and search engines are asked not to index it\./)).toBeInTheDocument();
  });

  it("copies the link", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValueOnce(undefined);
    const { user, app } = render();
    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/g/7f3kq9xm2a`);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Link copied"));
  });

  it("shows a private page, and confirms before making it public", async () => {
    vi.mocked(saveGroup).mockResolvedValue("g1");
    const { user, onSaved, app } = render({ public: false, show_callsigns: false, public_slug: null });
    expect(await screen.findByText(/Only you can see this page, when you are signed in\./)).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    await user.click(publicSwitch());
    const confirm = within(await screen.findByRole("dialog", { name: "Make the statistics page public?" }));
    await user.click(confirm.getByRole("button", { name: "Keep private" }));
    expect(publicSwitch()).not.toBeChecked();
    await user.click(publicSwitch());
    await user.click(within(await screen.findByRole("dialog", { name: "Make the statistics page public?" })).getByRole("button", { name: "Make public" }));
    expect(publicSwitch()).toBeChecked();
    // No link until the save has made one.
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(saveGroup).toHaveBeenCalledWith({
      id: "g1", name: "Piedmont ARC", callsigns: ["K4DEF", "KK4PWJ", "W4ABC"], public: true, show_callsigns: false,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(app.notify).toHaveBeenCalledWith("Saved changes");
  });

  it("saves a new name and members, and Cancel puts them back first", async () => {
    vi.mocked(saveGroup).mockResolvedValue("g1");
    const { user } = render();
    const name = await screen.findByRole("textbox", { name: "Name" });
    expect(screen.getByText("3 of 1,000 callsigns")).toBeInTheDocument();
    await user.clear(name);
    await user.type(name, "Changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(name).toHaveValue("Piedmont ARC");
    await user.clear(name);
    await user.type(name, " Piedmont club ");
    const chip = within(screen.getByTestId("group-members")).getByRole("button", { name: "KK4PWJ" });
    await user.click(within(chip).getByTestId("CancelIcon"));
    expect(screen.getByText("2 of 1,000 callsigns")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Show callsigns" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(saveGroup).toHaveBeenCalledWith({ id: "g1", name: "Piedmont club", callsigns: ["K4DEF", "W4ABC"], public: true, show_callsigns: false });
  });

  it("keeps a rename made while an add is being checked", async () => {
    let finish: (r: { callsigns: string[]; rejected: string[] }) => void = () => undefined;
    vi.mocked(normalizeCallsigns).mockReturnValue(new Promise((r) => (finish = r)));
    vi.mocked(saveGroup).mockResolvedValue("g1");
    const { user } = render();
    await user.type(await screen.findByRole("textbox", { name: "Paste callsigns" }), "n4dxx");
    await user.click(screen.getByRole("button", { name: "Add callsigns" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Renamed");
    finish({ callsigns: ["N4DXX"], rejected: [] });
    await screen.findByText("4 of 1,000 callsigns");
    expect(name).toHaveValue("Renamed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(saveGroup).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed", callsigns: ["K4DEF", "KK4PWJ", "N4DXX", "W4ABC"] }));
  });

  it("shows a refused save", async () => {
    vi.mocked(saveGroup).mockRejectedValue(new Error("You already have a group with that name."));
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("You already have a group with that name.")).toBeInTheDocument();
  });

  it("lists the connections that use the group and keeps Delete off while they do", async () => {
    render();
    const usedBy = (await screen.findByText("Connections that use this group in a rule")).closest(".MuiCard-root") as HTMLElement;
    expect(within(usedBy).getByText("POTA states I still need")).toBeInTheDocument();
    expect(within(usedBy).getByText("Piedmont club on the air")).toBeInTheDocument();
    expect(within(usedBy).queryByText("Other")).not.toBeInTheDocument();
    expect(within(usedBy).getAllByText("POTA")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Delete group" })).toBeDisabled();
    expect(screen.getByLabelText("Used by 2 connections. Remove it from them first.")).toBeInTheDocument();
  });

  it("deletes an unused group and goes back to Groups", async () => {
    vi.mocked(loadSubscriptions).mockResolvedValue([]);
    vi.mocked(deleteGroup).mockResolvedValue(undefined);
    const { user, app } = render({ subscription_count: 0 });
    expect(await screen.findByText("Not used by any connection")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete group" }));
    expect(deleteGroup).toHaveBeenCalledWith("g1");
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Deleted Piedmont ARC"));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/groups$/);
  });

  it("reports a delete the server refuses", async () => {
    vi.mocked(deleteGroup).mockRejectedValue(new Error("Remove it from its connections first."));
    const { user, app } = render({ subscription_count: 0 });
    await user.click(await screen.findByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Remove it from its connections first."));
  });

  it("says when the group can't load", async () => {
    vi.mocked(listGroups).mockRejectedValue(new Error(""));
    render();
    expect(await screen.findByText("Couldn't load the group.")).toBeInTheDocument();
  });
});
