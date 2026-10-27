import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { ApiError, loadRecentSpots, previewWebhookRequest, sendTest, type RecentSpot, type WebhookSettings } from "../lib/api";
import { DEFAULT_WEBHOOK_SETTINGS } from "./webhookModel";
import { WebhookPreviewCard, type WebhookPreviewCardProps } from "./WebhookPreviewCard";

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  }
  return { ApiError, loadRecentSpots: vi.fn(), previewWebhookRequest: vi.fn(), sendTest: vi.fn() };
});

const spot = (id: number, minutesAgo: number): RecentSpot => ({
  id, source: "pota", callsign: `K${id}ABC`, frequency_khz: 14062, mode: "cw", pota_reference: "US-0817", sota_summit_ref: null,
  wwff_reference: null, band: "20m", mode_family: "cw", comment: null, spotter: "W1AW", pota_location: null, pota_park_name: null,
  wwff_reference_name: null, wwbota_references: null, wwbota_reference_name: null, iota_reference: null, iota_reference_name: null, spot_time: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

// Key order that a jsonb round trip would sort differently: time before callsign, connection before delivery_id is not alphabetical.
const BODY = { delivery_id: 0, connection: "POTA states", spot: { time: "2026-10-17T17:42:09Z", callsign: "N0CALL", frequency_khz: 14062 } };

beforeEach(() => {
  vi.mocked(loadRecentSpots).mockReset().mockImplementation((source) => Promise.resolve(source === "pota" ? [spot(7, 1)] : []));
  vi.mocked(previewWebhookRequest).mockReset().mockResolvedValue(BODY);
  vi.mocked(sendTest).mockReset().mockResolvedValue({ status: 204 });
});

function render(props: Partial<WebhookPreviewCardProps> = {}) {
  return renderPage(
    <WebhookPreviewCard
      settings={DEFAULT_WEBHOOK_SETTINGS} path="/hook/••••••" headerLines={[]} hasUrl={false} dirty={false} {...props}
    />,
  );
}

const request = () => screen.getByLabelText("Request");

describe("WebhookPreviewCard", () => {
  it("shows the request line, the fixed headers in order, masked extra headers and SQL's body in its key order", async () => {
    render({ destinationId: "w1", headerLines: ["Authorization: ••••••••"] });
    expect(screen.getByText("Request preview")).toBeInTheDocument();
    await waitFor(() => expect(previewWebhookRequest).toHaveBeenCalledWith(DEFAULT_WEBHOOK_SETTINGS, null, "w1"));
    await waitFor(() => expect(request().textContent).toContain("delivery_id"));
    const lines = (request().textContent ?? "").split("\n");
    expect(lines.slice(0, 8)).toEqual([
      "POST /hook/••••••",
      "Accept: */*",
      "Content-Type: application/json",
      "User-Agent: LongLines/0.2",
      expect.stringMatching(/^X-LongLines-Timestamp: \d{10}$/),
      "X-LongLines-Signature: sha256=…",
      "Authorization: ••••••••",
      "",
    ]);
    expect(lines.slice(8).join("\n")).toBe(JSON.stringify(BODY, null, 2));
    expect(lines.slice(8).join("\n").indexOf('"time"')).toBeLessThan(lines.slice(8).join("\n").indexOf('"callsign"'));
  });

  it("previews a new destination without an id and the chosen spot", async () => {
    const { user } = render({ path: "/hook/abc123" });
    await waitFor(() => expect(previewWebhookRequest).toHaveBeenCalledWith(DEFAULT_WEBHOOK_SETTINGS, null, null));
    expect(request().textContent).toMatch(/^POST \/hook\/abc123\n/);
    await user.click(screen.getByRole("combobox", { name: "Preview with this spot" }));
    await user.click(await screen.findByRole("option", { name: /K7ABC/ }));
    await waitFor(() => expect(previewWebhookRequest).toHaveBeenLastCalledWith(DEFAULT_WEBHOOK_SETTINGS, 7, null));
  });

  it("re-previews only when the settings' content changes", async () => {
    function Harness() {
      const [settings, setSettings] = useState<WebhookSettings>({ ...DEFAULT_WEBHOOK_SETTINGS });
      return (
        <>
          <button type="button" onClick={() => setSettings({ ...settings, fields: [...settings.fields] })}>Copy</button>
          <button type="button" onClick={() => setSettings({ ...settings, key_style: "camel" })}>Change</button>
          <WebhookPreviewCard settings={settings} path="/" headerLines={[]} hasUrl={false} dirty={false} />
        </>
      );
    }
    const { user } = renderPage(<Harness />);
    await waitFor(() => expect(previewWebhookRequest).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(previewWebhookRequest).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(previewWebhookRequest).toHaveBeenCalledTimes(2));
    expect(previewWebhookRequest).toHaveBeenLastCalledWith({ ...DEFAULT_WEBHOOK_SETTINGS, key_style: "camel" }, null, null);
  });

  it("shows a preview error", async () => {
    vi.mocked(previewWebhookRequest).mockRejectedValue(new ApiError("Unknown field nope."));
    render();
    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown field nope.");
  });

  it("falls back to a generic preview error", async () => {
    vi.mocked(previewWebhookRequest).mockRejectedValue({});
    render();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the preview.");
  });

  it("gates Send test request with Discord's captions", () => {
    const { unmount } = render();
    expect(screen.getByRole("button", { name: "Send test request" })).toBeDisabled();
    expect(screen.getByText("Add a webhook URL to send a test.")).toBeInTheDocument();
    unmount();
    render({ hasUrl: true });
    expect(screen.getByText("Save your changes to send a test.")).toBeInTheDocument();
  });

  it("sends a test with the chosen spot and shows the status", async () => {
    const { user } = render({ destinationId: "w1", hasUrl: true });
    expect(
      screen.getByText("Sends this example to your URL and shows the response code. The test is marked as a test and is not counted as a delivery."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send test request" }));
    expect(sendTest).toHaveBeenCalledWith("w1", null);
    expect(await screen.findByText("Your URL answered HTTP 204.")).toBeInTheDocument();
  });

  it("shows nothing for a test without a status", async () => {
    vi.mocked(sendTest).mockResolvedValue({ status: null });
    const { user } = render({ destinationId: "w1", hasUrl: true });
    await user.click(screen.getByRole("button", { name: "Send test request" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test request" })).toBeEnabled());
    expect(screen.queryByText(/answered HTTP/)).not.toBeInTheDocument();
  });

  it("shows the receiver's failure, or the fallback", async () => {
    vi.mocked(sendTest).mockRejectedValueOnce(new ApiError("Webhook HTTP 500", "502")).mockRejectedValueOnce({});
    const { user } = render({ destinationId: "w1", hasUrl: true });
    await user.click(screen.getByRole("button", { name: "Send test request" }));
    expect(await screen.findByText("Webhook HTTP 500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send test request" }));
    expect(await screen.findByText("Couldn't send the test.")).toBeInTheDocument();
    expect(screen.queryByText("Webhook HTTP 500")).not.toBeInTheDocument();
  });
});
