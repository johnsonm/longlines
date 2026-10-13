import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { normalizeCallsigns, saveGroup } from "../lib/api";
import { GroupDialog } from "./GroupDialog";
import type { GroupInput, NormalizedCallsigns } from "./types";

vi.mock("../lib/api", () => ({ normalizeCallsigns: vi.fn(), saveGroup: vi.fn() }));

// A stand-in for normalize_group_callsigns: uppercase, drop /P, reject anything without a digit.
function fakeNormalize(values: string[]): Promise<NormalizedCallsigns> {
  const up = values.map((v) => v.trim().toUpperCase()).filter(Boolean);
  const valid = up.filter((v) => /\d/.test(v)).map((v) => v.replace(/\/P$/, ""));
  return Promise.resolve({ callsigns: [...new Set(valid)].sort(), rejected: up.filter((v) => !/\d/.test(v)) });
}

beforeEach(() => {
  vi.mocked(normalizeCallsigns).mockReset().mockImplementation(fakeNormalize);
  vi.mocked(saveGroup).mockReset();
});

function render(initial: GroupInput = { name: "", callsigns: [] }) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const r = renderPage(<GroupDialog initial={initial} onClose={onClose} onSaved={onSaved} />);
  return { ...r, onClose, onSaved };
}

const members = () => within(screen.getByTestId("group-members")).getAllByRole("button").map((c) => c.textContent);
const csvFile = (text: string, name = "roster.csv") => new File([text], name, { type: "text/csv" });

describe("GroupDialog", () => {
  it("starts empty with the save disabled until there is a name", async () => {
    const { user } = render();
    expect(screen.getByRole("dialog", { name: "New group" })).toBeInTheDocument();
    expect(screen.getByText("0 callsigns")).toBeInTheDocument();
    expect(screen.getByText("No callsigns yet. Type, paste, or import them on the left.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create group" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Group name" }), "   ");
    expect(screen.getByRole("button", { name: "Create group" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Group name" }), "RARS");
    expect(screen.getByRole("button", { name: "Create group" })).toBeEnabled();
  });

  it("adds typed calls with Enter as the server normalises them, listing what it rejected", async () => {
    const { user } = render({ name: "RARS", callsigns: ["N4DXX"] });
    const field = screen.getByRole("textbox", { name: "Callsign" });
    expect(field).toHaveAttribute("placeholder", "KK4PWJ");
    expect(screen.getByText("Press Enter to add. Spaces or commas add several at once.")).toBeInTheDocument();
    await user.type(field, "kk4pwj/p, ab4rd nope{Enter}");
    expect(normalizeCallsigns).toHaveBeenCalledWith(["kk4pwj/p", "ab4rd", "nope"]);
    await waitFor(() => expect(members()).toEqual(["AB4RD", "KK4PWJ", "N4DXX"]));
    expect(screen.getByText("3 callsigns")).toBeInTheDocument();
    expect(screen.getByText("Not callsigns, so not added: NOPE")).toBeInTheDocument();
    expect(field).toHaveValue("");
  });

  it("keeps the typed text when nothing in it was a callsign", async () => {
    const { user } = render();
    const field = screen.getByRole("textbox", { name: "Callsign" });
    await user.type(field, "nope");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Not callsigns, so not added: NOPE")).toBeInTheDocument();
    expect(field).toHaveValue("nope");
    expect(screen.getByText("0 callsigns")).toBeInTheDocument();
  });

  it("does nothing for a blank Enter", async () => {
    const { user } = render();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "  {Enter}");
    expect(normalizeCallsigns).not.toHaveBeenCalled();
  });

  it("adds a pasted block", async () => {
    const { user } = render();
    await user.click(screen.getByRole("tab", { name: "Paste" }));
    const area = screen.getByRole("textbox", { name: "Callsigns" });
    expect(screen.getByText("Separate them with commas, spaces or new lines.")).toBeInTheDocument();
    await user.click(area);
    await user.paste("W4KNX\nKO4YUF; N4CPA\tKK4PWJ");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(members()).toEqual(["KK4PWJ", "KO4YUF", "N4CPA", "W4KNX"]));
    expect(area).toHaveValue("");
  });

  it("refuses an add that would pass 1,000 and adds nothing", async () => {
    const full = Array.from({ length: 999 }, (_, i) => `K${i}AA`);
    const { user } = render({ name: "Big", callsigns: full });
    expect(screen.getByText("999 callsigns")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "W1AW W2AW{Enter}");
    expect(await screen.findByText("That would make 1,001 callsigns. A group can hold up to 1,000.")).toBeInTheDocument();
    expect(screen.getByText("999 callsigns")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Callsign" })).toHaveValue("W1AW W2AW");
    await user.clear(screen.getByRole("textbox", { name: "Callsign" }));
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "W1AW{Enter}");
    expect(await screen.findByText("1,000 callsigns")).toBeInTheDocument();
  });

  it("shows a failed check under the tab and clears it on a tab change", async () => {
    vi.mocked(normalizeCallsigns).mockRejectedValue(new Error(""));
    const { user } = render();
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "W1AW{Enter}");
    expect(await screen.findByText("Couldn't check those callsigns.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Paste" }));
    expect(screen.queryByText("Couldn't check those callsigns.")).not.toBeInTheDocument();
  });

  describe("Import CSV", () => {
    it("reports the column it found and what it skipped before adding", async () => {
      const { user } = render();
      await user.click(screen.getByRole("tab", { name: "Import CSV" }));
      expect(screen.getByText(/One callsign per row\. Long Lines uses the column headed Call or Callsign/)).toBeInTheDocument();
      await user.upload(screen.getByTestId("csv-input"), csvFile("Name,Callsign\nBrad,KK4PWJ\nAnn,ab4rd\nBob,nope\n"));
      expect(await screen.findByText("roster.csv: using the Callsign column. Found 2 callsigns, skipped 1.")).toBeInTheDocument();
      expect(normalizeCallsigns).toHaveBeenCalledWith(["KK4PWJ", "ab4rd", "nope"]);
      expect(screen.getByText("Not callsigns, so not added: NOPE")).toBeInTheDocument();
      expect(screen.getByText("No callsigns yet. Type, paste, or import them on the left.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Add" }));
      expect(members()).toEqual(["AB4RD", "KK4PWJ"]);
      expect(screen.queryByText(/roster\.csv: using/)).not.toBeInTheDocument();
    });

    it("falls back to the first column", async () => {
      const { user } = render();
      await user.click(screen.getByRole("tab", { name: "Import CSV" }));
      await user.upload(screen.getByTestId("csv-input"), csvFile("W1AW,x\n"));
      expect(await screen.findByText("roster.csv: using the first column. Found 1 callsign, skipped 0.")).toBeInTheDocument();
    });

    it("can't add a file with nothing valid in it", async () => {
      const { user } = render();
      await user.click(screen.getByRole("tab", { name: "Import CSV" }));
      await user.upload(screen.getByTestId("csv-input"), csvFile("Call\nnope\n"));
      expect(await screen.findByText(/Found 0 callsigns, skipped 1\./)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    });

    it("says when a file has no values", async () => {
      const { user } = render();
      await user.click(screen.getByRole("tab", { name: "Import CSV" }));
      await user.upload(screen.getByTestId("csv-input"), csvFile("Callsign\n\n", "empty.csv"));
      expect(await screen.findByText("No callsigns found in empty.csv.")).toBeInTheDocument();
      expect(normalizeCallsigns).not.toHaveBeenCalled();
    });

    it("says when a file can't be read", async () => {
      const { user } = render();
      await user.click(screen.getByRole("tab", { name: "Import CSV" }));
      const file = csvFile("x");
      vi.spyOn(file, "text").mockRejectedValue(new Error("gone"));
      await user.upload(screen.getByTestId("csv-input"), file);
      expect(await screen.findByText("Couldn't read that file.")).toBeInTheDocument();
    });

    it("refuses a file that would pass 1,000", async () => {
      const full = Array.from({ length: 1000 }, (_, i) => `K${i}AA`);
      const { user } = render({ name: "Big", callsigns: full });
      await user.click(screen.getByRole("tab", { name: "Import CSV" }));
      await user.upload(screen.getByTestId("csv-input"), csvFile("W1AW\n"));
      await user.click(await screen.findByRole("button", { name: "Add" }));
      expect(await screen.findByText("That would make 1,001 callsigns. A group can hold up to 1,000.")).toBeInTheDocument();
      expect(screen.getByText("1,000 callsigns")).toBeInTheDocument();
    });

    it("shows a failed check without a summary", async () => {
      vi.mocked(normalizeCallsigns).mockRejectedValue(new Error("Not signed in."));
      const { user } = render();
      await user.click(screen.getByRole("tab", { name: "Import CSV" }));
      await user.upload(screen.getByTestId("csv-input"), csvFile("W1AW\n"));
      expect(await screen.findByText("Not signed in.")).toBeInTheDocument();
      expect(screen.queryByText(/roster\.csv: using/)).not.toBeInTheDocument();
    });

    it("ignores a cancelled picker", () => {
      render();
      fireEvent.click(screen.getByRole("tab", { name: "Import CSV" }));
      fireEvent.change(screen.getByTestId("csv-input"), { target: { files: [] } });
      expect(normalizeCallsigns).not.toHaveBeenCalled();
    });
  });

  it("removes one chip, then all of them", async () => {
    const { user } = render({ id: "g1", name: "RARS", callsigns: ["AB4RD", "KK4PWJ", "N4DXX"] });
    const chip = within(screen.getByTestId("group-members")).getByRole("button", { name: "KK4PWJ" });
    await user.click(within(chip).getByTestId("CancelIcon"));
    expect(members()).toEqual(["AB4RD", "N4DXX"]);
    await user.click(screen.getByRole("button", { name: "Remove all" }));
    expect(screen.getByText("0 callsigns")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove all" })).toBeDisabled();
  });

  it("saves the whole list with the group's id", async () => {
    vi.mocked(saveGroup).mockResolvedValue("g1");
    const { user, onSaved } = render({ id: "g1", name: "RARS", callsigns: ["KK4PWJ"] });
    expect(screen.getByRole("dialog", { name: "Edit group" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "n4dxx{Enter}");
    await screen.findByText("2 callsigns");
    await user.clear(screen.getByRole("textbox", { name: "Group name" }));
    await user.type(screen.getByRole("textbox", { name: "Group name" }), " RARS members ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(saveGroup).toHaveBeenCalledWith({ id: "g1", name: "RARS members", callsigns: ["KK4PWJ", "N4DXX"] });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("RARS members"));
  });

  it("shows a server error in the dialog and stays open", async () => {
    vi.mocked(saveGroup).mockRejectedValue(new Error("You already have a group with that name."));
    const { user, onSaved, onClose } = render({ name: "RARS", callsigns: [] });
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByText("You already have a group with that name.")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create group" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("falls back to a generic save error", async () => {
    vi.mocked(saveGroup).mockRejectedValue(new Error(""));
    const { user } = render({ name: "RARS", callsigns: [] });
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(await screen.findByText("Couldn't save the group.")).toBeInTheDocument();
  });

  it("puts the panes side by side on desktop", () => {
    render();
    expect(screen.getByRole("dialog")).not.toHaveClass("MuiDialog-paperFullScreen");
    expect(getComputedStyle(screen.getByTestId("group-panes")).flexDirection).toBe("row");
  });

  it("goes full screen with the panes stacked on a phone", () => {
    setMobile(true);
    render();
    expect(screen.getByRole("dialog")).toHaveClass("MuiDialog-paperFullScreen");
    expect(getComputedStyle(screen.getByTestId("group-panes")).flexDirection).toBe("column");
  });
});
