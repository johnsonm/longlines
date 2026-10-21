import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { PushSettings } from "../lib/api";
import { DEFAULT_SETTINGS } from "./pushModel";
import { NotificationContentCard } from "./NotificationContentCard";

function render(overrides: Partial<PushSettings> = {}) {
  const onChange = vi.fn();
  const r = renderPage(<NotificationContentCard settings={{ ...DEFAULT_SETTINGS, ...overrides }} onChange={onChange} />);
  return { ...r, onChange };
}

const list = (heading: string) => within(screen.getByRole("heading", { name: heading }).parentElement!);
const addSelect = (heading: string) => list(heading).getByRole("combobox", { name: "Add a field" });

describe("NotificationContentCard", () => {
  it("lists the picked fields in order with their copy", () => {
    render();
    expect(screen.getByText("Choose which fields appear and in what order. Notifications cannot contain custom text.")).toBeInTheDocument();
    expect(list("Title").getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1Callsign", "2Frequency", "3Mode"]);
    expect(list("Body").getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1Source", "2Reference", "3Place name", "4State"]);
    expect(screen.getByText("Shown in bold. Phones cut off long titles.")).toBeInTheDocument();
    expect(screen.getByText("Place name is the park or summit.")).toBeInTheDocument();
    expect(screen.getByText("Adds a label before each value, such as State: NC.")).toBeInTheDocument();
    expect(screen.getByText("If a spot does not have a field, that field is skipped.")).toBeInTheDocument();
    expect(screen.getByText("Open profile, Open on the source site.")).toBeInTheDocument();
    expect(screen.getAllByText("Choose a field")).toHaveLength(2);
    // No free text anywhere.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("adds a field from the unpicked ones", async () => {
    const { user, onChange } = render();
    await user.click(addSelect("Title"));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["First name", "Last name", "Band", "Source", "Reference", "Place name", "State", "Spotter", "Comment", "Time"]);
    await user.click(screen.getByRole("option", { name: "Band" }));
    expect(onChange).toHaveBeenCalledWith({ title_fields: ["callsign", "frequency", "mode", "band"] });
  });

  it("refuses a fifth title field and a ninth body field", () => {
    render({
      title_fields: ["callsign", "frequency", "mode", "band"],
      body_fields: ["source", "reference", "place_name", "state", "spotter", "comment", "time", "band"],
    });
    expect(addSelect("Title")).toHaveAttribute("aria-disabled", "true");
    expect(addSelect("Body")).toHaveAttribute("aria-disabled", "true");
  });

  it("removes a field but never the title's last one", async () => {
    const { user, onChange } = render({ title_fields: ["callsign"], body_fields: ["source"] });
    expect(screen.getByRole("button", { name: "Remove Callsign" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove Source" }));
    expect(onChange).toHaveBeenCalledWith({ body_fields: [] });
  });

  it("shows an empty body", () => {
    render({ body_fields: [] });
    expect(list("Body").getByText("No fields")).toBeInTheDocument();
  });

  it("moves fields and disables the ends", async () => {
    const { user, onChange } = render();
    expect(screen.getByRole("button", { name: "Move Callsign up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Mode down" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move Callsign down" }));
    expect(onChange).toHaveBeenLastCalledWith({ title_fields: ["frequency", "callsign", "mode"] });
    await user.click(screen.getByRole("button", { name: "Move State up" }));
    expect(onChange).toHaveBeenLastCalledWith({ body_fields: ["source", "reference", "state", "place_name"] });
  });

  it("resets both lists to the defaults", async () => {
    const { user, onChange } = render({ title_fields: ["band"], body_fields: [] });
    await user.click(screen.getByRole("button", { name: "Reset to default fields" }));
    expect(onChange).toHaveBeenCalledWith({ title_fields: DEFAULT_SETTINGS.title_fields, body_fields: DEFAULT_SETTINGS.body_fields });
  });

  it("reports the switches and selects", async () => {
    const { user, onChange } = render();
    await user.click(screen.getByRole("switch", { name: "Show field names" }));
    expect(onChange).toHaveBeenLastCalledWith({ show_field_names: true });
    await user.click(screen.getByRole("combobox", { name: "Separate body fields with" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["A dot", "A comma", "A new line"]);
    await user.click(screen.getByRole("option", { name: "A new line" }));
    expect(onChange).toHaveBeenLastCalledWith({ body_separator: "newline" });
    await user.click(screen.getByRole("combobox", { name: "When tapped, open" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Callsign profile", "Source site"]);
    await user.click(screen.getByRole("option", { name: "Source site" }));
    expect(onChange).toHaveBeenLastCalledWith({ tap_target: "source" });
    await user.click(screen.getByRole("switch", { name: "Show action buttons" }));
    expect(onChange).toHaveBeenLastCalledWith({ action_buttons: false });
  });
});
