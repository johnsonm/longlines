import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { DiscordSettings } from "../lib/api";
import { DEFAULT_SETTINGS } from "./discordModel";
import { DiscordMessageCard } from "./DiscordMessageCard";

function render(overrides: Partial<DiscordSettings> = {}) {
  const onChange = vi.fn();
  const r = renderPage(<DiscordMessageCard settings={{ ...DEFAULT_SETTINGS, ...overrides }} onChange={onChange} />);
  return { ...r, onChange };
}

const list = (heading: string) => within(screen.getByRole("heading", { name: heading }).parentElement!);
const rows = (heading: string) => list(heading).getAllByRole("listitem").map((li) => li.textContent);
const addSelect = (heading: string) => list(heading).getByRole("combobox", { name: "Add a field" });

const SENTENCES = [
  "Messages can only contain the fields chosen above. You cannot add your own text or markup. Mentions such as @everyone are always turned off.",
  "If a spot does not have a field, that field is skipped. Comment is not available here, because it is text typed by the spotter.",
];

describe("DiscordMessageCard", () => {
  it("shows the header and both styles with their helpers", () => {
    render();
    expect(screen.getByText("Message")).toBeInTheDocument();
    expect(screen.getByText("Choose the style, then which fields appear and in what order.")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Message style" });
    expect(within(group).getByRole("radio", { name: /^Card/ })).toBeChecked();
    expect(within(group).getByRole("radio", { name: /^Plain line/ })).not.toBeChecked();
    expect(screen.getByText("A colored card with a title, details and a small grid. Easiest to scan.")).toBeInTheDocument();
    expect(screen.getByText("One line of text, like a chat message. Takes the least space.")).toBeInTheDocument();
    for (const s of SENTENCES) expect(screen.getByText(s)).toBeInTheDocument();
  });

  it("names each Add a field select by its list and describes it with the helper", () => {
    render();
    const helpers: Record<string, string> = {
      Title: "Shown in bold at the top of the card.",
      Details: "Shown under the title.",
      "Small grid": "Short values shown side by side under the details. Leave empty for no grid.",
    };
    for (const [heading, helper] of Object.entries(helpers)) {
      const select = within(screen.getByRole("group", { name: heading })).getByRole("combobox", { name: "Add a field" });
      expect(select).toHaveAccessibleDescription(helper);
    }
  });

  it("lays the card's three selects out in one grid row", () => {
    render();
    const rowOf = (name: string) => screen.getByRole("combobox", { name }).closest(".MuiGrid-container");
    const row = rowOf("Title links to");
    expect(row).not.toBeNull();
    expect(rowOf("Card color")).toBe(row);
    expect(rowOf("Separate fields with")).toBe(row);
    expect(row!.children).toHaveLength(3);
  });

  it("shows the card's lists, selects and switches", () => {
    render();
    expect(rows("Title")).toEqual(["1Callsign", "2Frequency", "3Mode"]);
    expect(rows("Details")).toEqual(["1Source", "2Reference", "3Place name", "4State"]);
    expect(rows("Small grid")).toEqual(["1Band", "2Spotter"]);
    expect(screen.getByText("Shown in bold at the top of the card.")).toBeInTheDocument();
    expect(screen.getByText("Shown under the title.")).toBeInTheDocument();
    expect(screen.getByText("Short values shown side by side under the details. Leave empty for no grid.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Title links to" })).toHaveTextContent("Callsign profile");
    expect(screen.getByText("Or the spot on the source site, or nothing.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Card color" })).toHaveTextContent("By source");
    expect(screen.getByText("POTA green, SOTA purple and so on. Or one color for all.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Separate fields with" })).toHaveTextContent("A dot");
    expect(screen.getByRole("switch", { name: "Show field names in details" })).not.toBeChecked();
    expect(screen.getByText("Adds a label before each value, such as State: NC.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Footer with source and time" })).toBeChecked();
    expect(screen.getByText("For example POTA, 17:42 UTC.")).toBeInTheDocument();
    expect(screen.getAllByText("Choose a field")).toHaveLength(3);
    // Nothing from the plain style, and no free text anywhere.
    expect(screen.queryByRole("heading", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Bold the first field" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Link preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the plain line's list, selects and switches", () => {
    render({ style: "plain" });
    expect(screen.getByRole("radio", { name: /^Plain line/ })).toBeChecked();
    expect(rows("Message")).toEqual(["1Callsign", "2Frequency", "3Mode", "4Source", "5Reference", "6Place name"]);
    expect(screen.getByText("Place name is the park or summit.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Separate fields with" })).toHaveTextContent("A dot");
    expect(screen.getByRole("switch", { name: "Bold the first field" })).toBeChecked();
    expect(screen.getByText("Makes the callsign stand out in a busy channel.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Show field names" })).not.toBeChecked();
    expect(screen.getByText("Adds a label before each value, such as State: NC.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Link preview" })).toHaveTextContent("Hidden");
    expect(screen.getByText("Stops Discord from expanding links in the message.")).toBeInTheDocument();
    for (const s of SENTENCES) expect(screen.getByText(s)).toBeInTheDocument();
    expect(screen.getAllByText("Choose a field")).toHaveLength(1);
    for (const heading of ["Title", "Details", "Small grid"]) expect(screen.queryByRole("heading", { name: heading })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Card color" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Footer with source and time" })).not.toBeInTheDocument();
  });

  it("switches the style without touching the lists", async () => {
    const { user, onChange } = render();
    await user.click(screen.getByRole("radio", { name: /^Plain line/ }));
    expect(onChange).toHaveBeenCalledWith({ style: "plain" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("switches back to the card", async () => {
    const { user, onChange } = render({ style: "plain" });
    await user.click(screen.getByRole("radio", { name: /^Card/ }));
    expect(onChange).toHaveBeenCalledWith({ style: "card" });
  });

  it("offers the ten fields minus the picked ones, never Comment", async () => {
    const { user, onChange } = render();
    await user.click(addSelect("Small grid"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Callsign", "Frequency", "Mode", "Source", "Reference", "Place name", "State", "Time",
    ]);
    await user.click(screen.getByRole("option", { name: "Time" }));
    expect(onChange).toHaveBeenCalledWith({ grid_fields: ["band", "spotter", "time"] });
  });

  it("adds to the title, details and plain line", async () => {
    const card = render();
    await card.user.click(addSelect("Title"));
    await card.user.click(screen.getByRole("option", { name: "Band" }));
    expect(card.onChange).toHaveBeenLastCalledWith({ title_fields: ["callsign", "frequency", "mode", "band"] });
    await card.user.click(addSelect("Details"));
    await card.user.click(screen.getByRole("option", { name: "Spotter" }));
    expect(card.onChange).toHaveBeenLastCalledWith({ detail_fields: ["source", "reference", "place_name", "state", "spotter"] });
    card.unmount();
    const plain = render({ style: "plain" });
    await plain.user.click(addSelect("Message"));
    await plain.user.click(screen.getByRole("option", { name: "State" }));
    expect(plain.onChange).toHaveBeenLastCalledWith({ line_fields: ["callsign", "frequency", "mode", "source", "reference", "place_name", "state"] });
  });

  it("refuses more than each list's limit", () => {
    const { unmount } = render({
      title_fields: ["callsign", "frequency", "mode", "band"],
      detail_fields: ["callsign", "frequency", "band", "mode", "source", "reference", "place_name", "state"],
      grid_fields: ["callsign", "frequency", "band", "mode", "source", "reference"],
    });
    expect(addSelect("Title")).toHaveAttribute("aria-disabled", "true");
    expect(addSelect("Details")).toHaveAttribute("aria-disabled", "true");
    expect(addSelect("Small grid")).toHaveAttribute("aria-disabled", "true");
    unmount();
    render({ style: "plain", line_fields: ["callsign", "frequency", "band", "mode", "source", "reference", "place_name", "state"] });
    expect(addSelect("Message")).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps one title field and one plain field, and lets details and grid go empty", async () => {
    const { user, onChange, unmount } = render({ title_fields: ["callsign"], detail_fields: ["source"], grid_fields: [] });
    expect(list("Title").getByRole("button", { name: "Remove Callsign" })).toBeDisabled();
    expect(list("Small grid").getByText("No fields")).toBeInTheDocument();
    await user.click(list("Details").getByRole("button", { name: "Remove Source" }));
    expect(onChange).toHaveBeenCalledWith({ detail_fields: [] });
    unmount();
    render({ style: "plain", line_fields: ["callsign"] });
    expect(list("Message").getByRole("button", { name: "Remove Callsign" })).toBeDisabled();
  });

  it("moves fields", async () => {
    const { user, onChange } = render();
    await user.click(list("Small grid").getByRole("button", { name: "Move Spotter up" }));
    expect(onChange).toHaveBeenLastCalledWith({ grid_fields: ["spotter", "band"] });
  });

  it("reports the card's selects and switches", async () => {
    const { user, onChange } = render();
    await user.click(screen.getByRole("combobox", { name: "Title links to" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Callsign profile", "Source site", "Nothing"]);
    await user.click(screen.getByRole("option", { name: "Nothing" }));
    expect(onChange).toHaveBeenLastCalledWith({ title_link: "none" });
    await user.click(screen.getByRole("combobox", { name: "Card color" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["By source", "Blue", "Green", "Purple", "Orange", "Red", "Grey"]);
    await user.click(screen.getByRole("option", { name: "Purple" }));
    expect(onChange).toHaveBeenLastCalledWith({ card_color: "purple" });
    await user.click(screen.getByRole("combobox", { name: "Separate fields with" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["A dot", "A comma", "A new line"]);
    await user.click(screen.getByRole("option", { name: "A comma" }));
    expect(onChange).toHaveBeenLastCalledWith({ separator: "comma" });
    await user.click(screen.getByRole("switch", { name: "Show field names in details" }));
    expect(onChange).toHaveBeenLastCalledWith({ show_field_names: true });
    await user.click(screen.getByRole("switch", { name: "Footer with source and time" }));
    expect(onChange).toHaveBeenLastCalledWith({ footer: false });
  });

  it("reports the plain line's selects and switches", async () => {
    const { user, onChange } = render({ style: "plain" });
    await user.click(screen.getByRole("combobox", { name: "Separate fields with" }));
    await user.click(screen.getByRole("option", { name: "A new line" }));
    expect(onChange).toHaveBeenLastCalledWith({ separator: "newline" });
    await user.click(screen.getByRole("switch", { name: "Bold the first field" }));
    expect(onChange).toHaveBeenLastCalledWith({ bold_first: false });
    await user.click(screen.getByRole("switch", { name: "Show field names" }));
    expect(onChange).toHaveBeenLastCalledWith({ show_field_names: true });
    await user.click(screen.getByRole("combobox", { name: "Link preview" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Hidden", "Shown"]);
    await user.click(screen.getByRole("option", { name: "Shown" }));
    expect(onChange).toHaveBeenLastCalledWith({ link_preview: "shown" });
  });

  it("resets only the four field lists", async () => {
    const { user, onChange } = render({
      style: "plain", title_fields: ["band"], detail_fields: [], grid_fields: [], line_fields: ["time"], separator: "comma", footer: false,
    });
    await user.click(screen.getByRole("button", { name: "Reset to default fields" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      title_fields: DEFAULT_SETTINGS.title_fields,
      detail_fields: DEFAULT_SETTINGS.detail_fields,
      grid_fields: DEFAULT_SETTINGS.grid_fields,
      line_fields: DEFAULT_SETTINGS.line_fields,
    });
  });
});
