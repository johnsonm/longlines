import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { WebhookSettings } from "../lib/api";
import { DEFAULT_WEBHOOK_SETTINGS } from "./webhookModel";
import { WebhookDeliveryCard } from "./WebhookDeliveryCard";

vi.mock("../lib/api", () => ({}));

function Harness({ initial = {}, spy }: { initial?: Partial<WebhookSettings>; spy: (patch: Partial<WebhookSettings>) => void }) {
  const [settings, setSettings] = useState<WebhookSettings>({ ...DEFAULT_WEBHOOK_SETTINGS, ...initial });
  return (
    <WebhookDeliveryCard
      settings={settings}
      onChange={(patch) => {
        spy(patch);
        setSettings({ ...settings, ...patch });
      }}
    />
  );
}

const ONE = "Or group spots into one request every 10, 30 or 60 seconds. Grouped requests send a spots list instead of a single spot.";
const GROUPED = "Or send one request per spot. Grouped requests send a spots list instead of a single spot.";

describe("WebhookDeliveryCard", () => {
  it("shows the header, the selects with their helpers and the pause switch on", () => {
    renderPage(<Harness spy={vi.fn()} />);
    expect(screen.getByText("Delivery")).toBeInTheDocument();
    expect(screen.getByText("How requests are sent and what happens when they fail")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Requests" })).toHaveTextContent("One request per spot");
    expect(screen.getByText(ONE)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Retry a failed request" })).toHaveTextContent("Up to 3 times over 10 minutes");
    expect(screen.getByText("A request fails on a timeout after 10 seconds or any status other than 2xx.")).toBeInTheDocument();
    expect(screen.getByText("Pause this destination after repeated failures")).toBeInTheDocument();
    expect(screen.getByText("After 20 failed requests in a row, deliveries stop. Turn it back on here.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Pause after repeated failures" })).toBeChecked();
  });

  it("round-trips Requests as a number and switches its helper", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness spy={spy} />);
    await user.click(screen.getByRole("combobox", { name: "Requests" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "One request per spot", "Group spots every 10 seconds", "Group spots every 30 seconds", "Group spots every 60 seconds",
    ]);
    await user.click(screen.getByRole("option", { name: "Group spots every 30 seconds" }));
    expect(spy).toHaveBeenLastCalledWith({ batch_seconds: 30 });
    expect(screen.getByText(GROUPED)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Requests" }));
    await user.click(screen.getByRole("option", { name: "One request per spot" }));
    expect(spy).toHaveBeenLastCalledWith({ batch_seconds: 0 });
    expect(screen.getByText(ONE)).toBeInTheDocument();
  });

  it("round-trips the retry policy", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness spy={spy} />);
    await user.click(screen.getByRole("combobox", { name: "Retry a failed request" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Don't retry", "Up to 3 times over 10 minutes", "Keep trying for 24 hours",
    ]);
    await user.click(screen.getByRole("option", { name: "Keep trying for 24 hours" }));
    expect(spy).toHaveBeenLastCalledWith({ retry_policy: "day" });
    expect(screen.getByRole("combobox", { name: "Retry a failed request" })).toHaveTextContent("Keep trying for 24 hours");
  });

  it("maps the pause switch to 20 and null", async () => {
    const spy = vi.fn();
    const { user } = renderPage(<Harness initial={{ pause_after_failures: null }} spy={spy} />);
    const pause = screen.getByRole("switch", { name: "Pause after repeated failures" });
    expect(pause).not.toBeChecked();
    await user.click(pause);
    expect(spy).toHaveBeenLastCalledWith({ pause_after_failures: 20 });
    await user.click(pause);
    expect(spy).toHaveBeenLastCalledWith({ pause_after_failures: null });
  });
});
