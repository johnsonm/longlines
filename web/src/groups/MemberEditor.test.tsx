import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { normalizeCallsigns } from "../lib/api";
import { MemberEditor } from "./MemberEditor";
import type { NormalizedCallsigns } from "./types";

vi.mock("../lib/api", () => ({ normalizeCallsigns: vi.fn() }));

// A stand-in for normalize_group_callsigns: uppercase, drop /P, reject anything without a digit.
function fakeNormalize(values: string[]): Promise<NormalizedCallsigns> {
  const up = values.map((v) => v.trim().toUpperCase()).filter(Boolean);
  const valid = up.filter((v) => /\d/.test(v)).map((v) => v.replace(/\/P$/, ""));
  return Promise.resolve({ callsigns: [...new Set(valid)].sort(), rejected: up.filter((v) => !/\d/.test(v)) });
}

beforeEach(() => {
  vi.mocked(normalizeCallsigns).mockReset().mockImplementation(fakeNormalize);
});

function Harness({ initial }: { initial: string[] }) {
  const [calls, setCalls] = useState(initial);
  return (
    <>
      <span data-testid="count">{calls.length}</span>
      <MemberEditor calls={calls} onChange={setCalls} />
    </>
  );
}

function render(initial: string[] = []) {
  return renderPage(<Harness initial={initial} />);
}

const members = () =>
  within(screen.getByTestId("group-members")).getAllByRole("button").map((c) => c.textContent).filter((t) => !t?.endsWith("more"));
const count = () => Number(screen.getByTestId("count").textContent);
const csvFile = (text: string, name = "roster.csv") => new File([text], name, { type: "text/csv" });

describe("MemberEditor", () => {
  it("starts on Paste with an empty list", () => {
    render();
    expect(screen.getByRole("tab", { name: "Paste", selected: true })).toBeInTheDocument();
    expect(screen.getByText("Separate with commas, spaces or new lines.")).toBeInTheDocument();
    expect(screen.getByText("No callsigns yet. Type, paste, or import them above.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add callsigns" })).toBeDisabled();
  });

  it("adds typed calls with Enter as the server normalises them, listing what it rejected", async () => {
    const { user } = render(["N4DXX"]);
    await user.click(screen.getByRole("tab", { name: "Type" }));
    const field = screen.getByRole("textbox", { name: "Callsign" });
    expect(field).toHaveAttribute("placeholder", "KK4PWJ");
    expect(screen.getByText("Press Enter to add. Spaces or commas add several at once.")).toBeInTheDocument();
    await user.type(field, "kk4pwj/p, ab4rd nope{Enter}");
    expect(normalizeCallsigns).toHaveBeenCalledWith(["kk4pwj/p", "ab4rd", "nope"]);
    await waitFor(() => expect(members()).toEqual(["AB4RD", "KK4PWJ", "N4DXX"]));
    expect(screen.getByText("Not callsigns, so not added: NOPE")).toBeInTheDocument();
    expect(field).toHaveValue("");
  });

  it("keeps the typed text when nothing in it was a callsign, and ignores a blank Enter", async () => {
    const { user } = render();
    await user.click(screen.getByRole("tab", { name: "Type" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "  {Enter}");
    expect(normalizeCallsigns).not.toHaveBeenCalled();
    const field = screen.getByRole("textbox", { name: "Callsign" });
    await user.clear(field);
    await user.type(field, "nope");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Not callsigns, so not added: NOPE")).toBeInTheDocument();
    expect(field).toHaveValue("nope");
    expect(count()).toBe(0);
  });

  it("adds a pasted block", async () => {
    const { user } = render();
    const area = screen.getByRole("textbox", { name: "Paste callsigns" });
    await user.click(area);
    await user.paste("W4KNX\nKO4YUF; N4CPA\tKK4PWJ");
    await user.click(screen.getByRole("button", { name: "Add callsigns" }));
    await waitFor(() => expect(members()).toEqual(["KK4PWJ", "KO4YUF", "N4CPA", "W4KNX"]));
    expect(area).toHaveValue("");
  });

  it("refuses an add that would pass 1,000 and adds nothing", async () => {
    const { user } = render(Array.from({ length: 999 }, (_, i) => `K${i}AA`));
    await user.click(screen.getByText("Type"));
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "W1AW W2AW{Enter}");
    expect(await screen.findByText("That would make 1,001 callsigns. A group can hold up to 1,000.")).toBeInTheDocument();
    expect(count()).toBe(999);
    await user.clear(screen.getByRole("textbox", { name: "Callsign" }));
    await user.type(screen.getByRole("textbox", { name: "Callsign" }), "W1AW{Enter}");
    await waitFor(() => expect(count()).toBe(1000));
  });

  it("shows a failed check under the tab and clears it on a tab change", async () => {
    vi.mocked(normalizeCallsigns).mockRejectedValue(new Error(""));
    const { user } = render();
    await user.type(screen.getByRole("textbox", { name: "Paste callsigns" }), "W1AW");
    await user.click(screen.getByRole("button", { name: "Add callsigns" }));
    expect(await screen.findByText("Couldn't check those callsigns.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Type" }));
    expect(screen.queryByText("Couldn't check those callsigns.")).not.toBeInTheDocument();
  });

  it("shows the first 40 members, then all of them from +N more, and searches", async () => {
    const calls = Array.from({ length: 48 }, (_, i) => `K${String(i).padStart(2, "0")}AA`);
    const { user } = render(calls);
    expect(members()).toHaveLength(40);
    await user.click(screen.getByText("+8 more"));
    expect(members()).toHaveLength(48);
    await user.type(screen.getByRole("textbox", { name: "Search members" }), "k4");
    expect(members()).toEqual(["K40AA", "K41AA", "K42AA", "K43AA", "K44AA", "K45AA", "K46AA", "K47AA"]);
    expect(count()).toBe(48);
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
      const { user } = render(Array.from({ length: 1000 }, (_, i) => `K${i}AA`));
      await user.click(screen.getByText("Import CSV"));
      await user.upload(screen.getByTestId("csv-input"), csvFile("W1AW\n"));
      await user.click(await screen.findByText("Add", { selector: "button" }));
      expect(await screen.findByText("That would make 1,001 callsigns. A group can hold up to 1,000.")).toBeInTheDocument();
      expect(count()).toBe(1000);
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
    const { user } = render(["AB4RD", "KK4PWJ", "N4DXX"]);
    const chip = within(screen.getByTestId("group-members")).getByRole("button", { name: "KK4PWJ" });
    await user.click(within(chip).getByTestId("CancelIcon"));
    expect(members()).toEqual(["AB4RD", "N4DXX"]);
    await user.click(screen.getByRole("button", { name: "Remove all" }));
    expect(count()).toBe(0);
    expect(screen.getByRole("button", { name: "Remove all" })).toBeDisabled();
  });

  it("locks the list while an add is being checked, so a removal can't be undone by it", async () => {
    let finish: (r: NormalizedCallsigns) => void = () => undefined;
    vi.mocked(normalizeCallsigns).mockReturnValue(new Promise((r) => (finish = r)));
    const { user } = render(["AB4RD", "KK4PWJ"]);
    await user.type(screen.getByRole("textbox", { name: "Paste callsigns" }), "n4dxx");
    await user.click(screen.getByRole("button", { name: "Add callsigns" }));
    const chip = within(screen.getByTestId("group-members")).getByRole("button", { name: "KK4PWJ" });
    expect(chip).toHaveClass("Mui-disabled");
    expect(screen.getByRole("button", { name: "Remove all" })).toBeDisabled();
    finish({ callsigns: ["N4DXX"], rejected: [] });
    await waitFor(() => expect(members()).toEqual(["AB4RD", "KK4PWJ", "N4DXX"]));
    expect(screen.getByRole("button", { name: "Remove all" })).toBeEnabled();
  });
});
