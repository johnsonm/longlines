import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { saveGroup } from "../lib/api";
import { NewGroupDialog } from "./NewGroupDialog";

vi.mock("../lib/api", () => ({ saveGroup: vi.fn() }));

beforeEach(() => {
  vi.mocked(saveGroup).mockReset();
});

function render() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  return { ...renderPage(<NewGroupDialog onClose={onClose} onCreated={onCreated} />), onClose, onCreated };
}

describe("NewGroupDialog", () => {
  it("shows the copy and keeps Create group off until there is a name", async () => {
    const { user } = render();
    expect(screen.getByText("Name the group and add its callsigns. You can add more later.")).toBeInTheDocument();
    expect(screen.getByText("Names are unique. A name can be reused after the group that has it is deleted.")).toBeInTheDocument();
    expect(screen.getByText("Separate with commas, spaces or new lines. You can also import a CSV later.")).toBeInTheDocument();
    expect(screen.getByText("Off by default. When on, anyone with the link can see the club statistics.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create group" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " ");
    expect(screen.getByRole("button", { name: "Create group" })).toBeDisabled();
  });

  it("confirms before going public, and Keep private turns the switch back off", async () => {
    const { user } = render();
    await user.type(screen.getByRole("textbox", { name: "Callsigns" }), "W4ABC K4DEF\nN4GHI");
    await user.click(screen.getByRole("switch", { name: "Public statistics page" }));
    const confirm = within(await screen.findByRole("dialog", { name: "Make the statistics page public?" }));
    expect(confirm.getByText("Club totals only, without callsigns")).toBeInTheDocument();
    await user.click(confirm.getByRole("checkbox", { name: "Show each member's callsign on the public page" }));
    expect(confirm.getByText("The callsigns of all 3 members, and how active each one is")).toBeInTheDocument();
    await user.click(confirm.getByRole("button", { name: "Keep private" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Make the statistics page public?" })).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Public statistics page" })).not.toBeChecked();
  });

  it("creates a public group with the choice made in the confirm dialog", async () => {
    vi.mocked(saveGroup).mockResolvedValue("g1");
    const { user, onCreated } = render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Piedmont ARC");
    await user.click(screen.getByRole("switch", { name: "Public statistics page" }));
    const confirm = within(await screen.findByRole("dialog", { name: "Make the statistics page public?" }));
    await user.click(confirm.getByRole("checkbox", { name: "Show each member's callsign on the public page" }));
    await user.click(confirm.getByRole("button", { name: "Make public" }));
    expect(screen.getByRole("switch", { name: "Public statistics page" })).toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Public statistics page" }));
    expect(screen.getByRole("switch", { name: "Public statistics page" })).not.toBeChecked();
    await user.click(screen.getByRole("switch", { name: "Public statistics page" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Make the statistics page public?" })).getByRole("button", { name: "Make public" }));
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(saveGroup).toHaveBeenCalledWith({ name: "Piedmont ARC", callsigns: [], public: true, show_callsigns: true });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("g1", "Piedmont ARC"));
  });

  it("shows what SQL refuses and stays open; Cancel closes", async () => {
    vi.mocked(saveGroup).mockRejectedValue(new Error("Not a callsign: ZZ!."));
    const { user, onClose, onCreated } = render();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Club");
    await user.type(screen.getByRole("textbox", { name: "Callsigns" }), "zz!");
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByText("Not a callsign: ZZ!.")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
