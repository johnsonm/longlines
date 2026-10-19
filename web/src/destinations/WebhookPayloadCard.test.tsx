import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { WebhookSettings } from "../lib/api";
import { DEFAULT_WEBHOOK_SETTINGS } from "./webhookModel";
import { WebhookPayloadCard } from "./WebhookPayloadCard";

vi.mock("../lib/api", () => ({}));

/** Holds the settings like the page does and reports each one it sees. */
function Harness({ initial = {}, spy }: { initial?: Partial<WebhookSettings>; spy?: (s: WebhookSettings) => void }) {
  const [settings, setSettings] = useState<WebhookSettings>({ ...DEFAULT_WEBHOOK_SETTINGS, ...initial });
  return (
    <WebhookPayloadCard
      settings={settings}
      onChange={(patch) => {
        const next = { ...settings, ...patch };
        spy?.(next);
        setSettings(next);
      }}
    />
  );
}

const list = () => within(screen.getByRole("group", { name: "Included, in this order" }));
const rows = () => list().getAllByRole("listitem").map((li) => li.textContent);

describe("WebhookPayloadCard", () => {
  it("shows the header, the envelope box and the default fields with their keys", () => {
    renderPage(<Harness />);
    expect(screen.getByText("Payload")).toBeInTheDocument();
    expect(
      screen.getByText("Choose which fields are in each request and in what order. Key names are fixed, and you cannot add custom fields or text."),
    ).toBeInTheDocument();
    expect(screen.getByText("Always sent")).toBeInTheDocument();
    expect(screen.getByText(/identifies the delivery, so you can spot a retry\./).textContent).toBe(
      "delivery_id identifies the delivery, so you can spot a retry. connection names the connection that matched. Spot fields go inside spot.",
    );
    expect(rows()).toEqual([
      "1Spot IDid", "2Timetime", "3Callsigncallsign", "4Frequencyfrequency_khz", "5Modemode", "6Bandband", "7Sourcesource",
      "8Referencereference", "9Place nameplace_name", "10Statestate", "11Spotterspotter",
    ]);
    expect(screen.getByText("Not included")).toBeInTheDocument();
    expect(
      screen.getByText("Comment is text typed by the person who spotted, so treat it as untrusted. It is sent as a quoted JSON string, never as markup."),
    ).toBeInTheDocument();
  });

  it("adds by chip, moves and removes, and keeps the minimum of one", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness initial={{ fields: ["callsign", "time"] }} spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Add Country" }));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ fields: ["callsign", "time", "country"] }));
    await user.click(list().getByRole("button", { name: "Move Country up" }));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ fields: ["callsign", "country", "time"] }));
    await user.click(list().getByRole("button", { name: "Remove Callsign" }));
    await user.click(list().getByRole("button", { name: "Remove Time" }));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ fields: ["country"] }));
    expect(list().getByRole("button", { name: "Remove Country" })).toBeDisabled();
  });

  it("names the keys by the key style and frequency unit", async () => {
    const { user } = renderPage(<Harness />);
    await user.click(screen.getByRole("combobox", { name: "Key style" }));
    await user.click(screen.getByRole("option", { name: "camelCase" }));
    expect(list().getByText("placeName")).toBeInTheDocument();
    expect(list().getByText("frequencyKhz")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Frequency unit" }));
    await user.click(screen.getByRole("option", { name: "MHz" }));
    expect(list().getByText("frequencyMhz")).toBeInTheDocument();
  });

  it("offers each select's choices and changes the helpers with them", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness spy={spy} />);
    expect(screen.getByText("Keys such as place_name or placeName.")).toBeInTheDocument();
    expect(screen.getByText("Changes the key name too.")).toBeInTheDocument();
    expect(screen.getByText("2026-10-17T17:42:09Z")).toBeInTheDocument();
    expect(screen.getByText("Or send null.")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Key style" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["snake_case", "camelCase"]);
    await user.click(screen.getByRole("option", { name: "snake_case" }));

    await user.click(screen.getByRole("combobox", { name: "Time format" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["ISO 8601, UTC", "Unix seconds"]);
    await user.click(screen.getByRole("option", { name: "Unix seconds" }));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ time_format: "unix_seconds" }));
    expect(screen.getByText("1792258929")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Frequency unit" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["kHz", "MHz", "Hz"]);
    await user.click(screen.getByRole("option", { name: "Hz" }));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ frequency_unit: "hz" }));

    await user.click(screen.getByRole("combobox", { name: "When a spot has no value" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Leave the key out", "Send null"]);
    await user.click(screen.getByRole("option", { name: "Send null" }));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ missing_values: "null" }));
    expect(screen.getByText("Or leave the key out.")).toBeInTheDocument();
  });

  it("hides Not included when every field is included, keeping the note", () => {
    renderPage(
      <Harness
        initial={{
          fields: ["id", "time", "callsign", "frequency", "mode", "band", "source", "reference", "place_name", "state", "spotter", "country", "url",
            "comment"],
        }}
      />,
    );
    expect(screen.queryByText("Not included")).not.toBeInTheDocument();
    expect(screen.getByText(/Comment is text typed by the person who spotted/)).toBeInTheDocument();
  });

  it("resets only the fields, leaving the selects alone", async () => {
    const spy = vi.fn();
    const initial: Partial<WebhookSettings> = { fields: ["comment"], key_style: "camel", time_format: "unix_seconds", frequency_unit: "hz", missing_values: "null" };
    const { user } = renderPage(<Harness initial={initial} spy={spy} />);
    await user.click(screen.getByRole("button", { name: "Reset to default fields" }));
    expect(spy).toHaveBeenLastCalledWith({ ...DEFAULT_WEBHOOK_SETTINGS, ...initial, fields: DEFAULT_WEBHOOK_SETTINGS.fields });
    expect(screen.getByRole("combobox", { name: "Key style" })).toHaveTextContent("camelCase");
  });
});
