import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { loadRecentSpots, previewDiscordMessage, sendTest, type DiscordPreview, type DiscordSettings, type RecentSpot } from "../lib/api";
import { DEFAULT_SETTINGS } from "./discordModel";
import { DiscordPreviewCard } from "./DiscordPreviewCard";

vi.mock("../lib/api", () => ({
  loadRecentSpots: vi.fn(),
  previewDiscordMessage: vi.fn(),
  sendTest: vi.fn(),
}));

const spot = (id: number, source: string, minutesAgo: number): RecentSpot => ({
  id, source, callsign: `K${id}ABC`, frequency_khz: 14062, mode: "cw", pota_reference: source === "pota" ? "US-0817" : null,
  sota_summit_ref: source === "sotawatch" ? "W4C/CM-001" : null, wwff_reference: null, band: "20m", mode_family: "cw", comment: null,
  spotter: "W1AW", pota_location: null, pota_park_name: null, wwff_reference_name: null,
  spot_time: new Date(Date.parse("2026-10-17T12:00:00Z") - minutesAgo * 60_000).toISOString(),
});

const PREVIEW: DiscordPreview = {
  discord_style: "card", discord_title: "N0CALL · 14.062 MHz · CW", discord_description: "POTA · US-0000 · Test Park",
  discord_grid: [{ name: "Band", value: "20m" }], discord_footer: "POTA, 17:42 UTC", discord_color: 0x3ba55c,
  discord_url: "https://longlines.io/call/N0CALL", discord_line: "**N0CALL** · 14.062 MHz", discord_suppress_embeds: false,
};

beforeEach(() => {
  vi.mocked(loadRecentSpots).mockReset().mockImplementation((source) =>
    Promise.resolve(source === "pota" ? [spot(1, "pota", 1), spot(2, "pota", 30)] : source === "sotawatch" ? [spot(3, "sotawatch", 5)] : []),
  );
  vi.mocked(previewDiscordMessage).mockReset().mockResolvedValue(PREVIEW);
  vi.mocked(sendTest).mockReset().mockResolvedValue({ status: null });
});

interface Opts {
  settings?: Partial<DiscordSettings>;
  destinationId?: string;
  hasUrl?: boolean;
  dirty?: boolean;
}

function render({ settings = {}, destinationId, hasUrl = false, dirty = false }: Opts = {}) {
  return renderPage(
    <DiscordPreviewCard settings={{ ...DEFAULT_SETTINGS, ...settings }} destinationId={destinationId} name="Spots channel" hasUrl={hasUrl} dirty={dirty} />,
  );
}

const figure = () => within(screen.getByRole("figure", { name: "Discord message" }));
const sendButton = () => screen.getByRole("button", { name: "Send test message" });

describe("DiscordPreviewCard", () => {
  it("previews the sample spot with SQL's text and the caption", async () => {
    render();
    expect(screen.getByText("Preview")).toBeInTheDocument();
    await waitFor(() => expect(previewDiscordMessage).toHaveBeenCalledWith(DEFAULT_SETTINGS, null));
    expect(await figure().findByText("N0CALL · 14.062 MHz · CW")).toBeInTheDocument();
    expect(figure().getByText("POTA · US-0000 · Test Park")).toBeInTheDocument();
    expect(screen.getByText("Shown in Discord dark theme. Light theme and mobile follow the viewer's settings.")).toBeInTheDocument();
  });

  it("re-previews only when the settings' content changes", async () => {
    function Harness() {
      const [settings, setSettings] = useState<DiscordSettings>({ ...DEFAULT_SETTINGS });
      return (
        <>
          <button type="button" onClick={() => setSettings({ ...settings, title_fields: [...settings.title_fields] })}>Copy</button>
          <button type="button" onClick={() => setSettings({ ...settings, footer: !settings.footer })}>Change</button>
          <DiscordPreviewCard settings={settings} name="Spots channel" hasUrl={false} dirty={false} />
        </>
      );
    }
    const { user } = renderPage(<Harness />);
    await waitFor(() => expect(previewDiscordMessage).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(previewDiscordMessage).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Change" }));
    await waitFor(() => expect(previewDiscordMessage).toHaveBeenCalledTimes(2));
    expect(previewDiscordMessage).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, footer: !DEFAULT_SETTINGS.footer }, null);
  });

  it("debounces quick changes into one preview of the last settings", async () => {
    function Harness() {
      const [settings, setSettings] = useState<DiscordSettings>({ ...DEFAULT_SETTINGS });
      return (
        <>
          <button type="button" onClick={() => setSettings((s) => ({ ...s, footer: !s.footer }))}>Footer</button>
          <button type="button" onClick={() => setSettings((s) => ({ ...s, show_field_names: !s.show_field_names }))}>Names</button>
          <DiscordPreviewCard settings={settings} name="Spots channel" hasUrl={false} dirty={false} />
        </>
      );
    }
    const { user } = renderPage(<Harness />);
    await waitFor(() => expect(previewDiscordMessage).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Footer" }));
    await user.click(screen.getByRole("button", { name: "Names" }));
    // Neither change has fired a request inside the 300 ms window.
    expect(previewDiscordMessage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(previewDiscordMessage).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 400));
    expect(previewDiscordMessage).toHaveBeenCalledTimes(2);
    expect(previewDiscordMessage).toHaveBeenLastCalledWith(
      { ...DEFAULT_SETTINGS, footer: !DEFAULT_SETTINGS.footer, show_field_names: !DEFAULT_SETTINGS.show_field_names }, null,
    );
  });

  it("previews the chosen recent spot", async () => {
    const { user } = render({ settings: { style: "plain" } });
    await waitFor(() => expect(loadRecentSpots).toHaveBeenCalledTimes(4));
    await user.click(screen.getByRole("combobox", { name: "Preview with this spot" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Sample spot", "K1ABC, POTA US-0817, 14062 CW", "K3ABC, SOTAwatch W4C/CM-001, 14062 CW", "K2ABC, POTA US-0817, 14062 CW",
    ]);
    vi.mocked(previewDiscordMessage).mockResolvedValue({ ...PREVIEW, discord_style: "plain", discord_line: "**K3ABC** · W4C/CM-001" });
    await user.click(screen.getByRole("option", { name: "K3ABC, SOTAwatch W4C/CM-001, 14062 CW" }));
    await waitFor(() => expect(previewDiscordMessage).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, style: "plain" }, 3));
    expect(await screen.findByTestId("discord-line")).toHaveTextContent("K3ABC · W4C/CM-001");
  });

  it("shows the preview error, with a fallback", async () => {
    vi.mocked(previewDiscordMessage).mockRejectedValue(new Error("Pick 1 to 8 fields for the message."));
    const first = render();
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick 1 to 8 fields for the message.");
    first.unmount();
    vi.mocked(previewDiscordMessage).mockRejectedValue("boom");
    render();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the preview.");
  });

  it("explains why a test cannot be sent", () => {
    const first = render();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Add a webhook URL to send a test.")).toBeInTheDocument();
    first.unmount();
    // A new destination with a valid URL typed has to be saved first.
    const unsaved = render({ hasUrl: true, dirty: true });
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Save your changes to send a test.")).toBeInTheDocument();
    unsaved.unmount();
    const second = render({ destinationId: "d1", hasUrl: false });
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Add a webhook URL to send a test.")).toBeInTheDocument();
    second.unmount();
    const third = render({ destinationId: "d1", hasUrl: true, dirty: true });
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Save your changes to send a test.")).toBeInTheDocument();
    third.unmount();
    render({ destinationId: "d1", hasUrl: true });
    expect(sendButton()).toBeEnabled();
    expect(screen.getByText("Posts this example to the channel, marked as a test.")).toBeInTheDocument();
  });

  it("sends the test with the chosen spot and toasts", async () => {
    const { user, app } = render({ destinationId: "d1", hasUrl: true });
    await user.click(sendButton());
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Spots channel"));
    expect(sendTest).toHaveBeenCalledWith("d1", null);

    await user.click(screen.getByRole("combobox", { name: "Preview with this spot" }));
    await user.click(await screen.findByRole("option", { name: "K1ABC, POTA US-0817, 14062 CW" }));
    vi.mocked(sendTest).mockRejectedValue(new Error("Use a Discord webhook URL."));
    await user.click(sendButton());
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Use a Discord webhook URL."));
    expect(sendTest).toHaveBeenLastCalledWith("d1", 1);

    vi.mocked(sendTest).mockRejectedValue("boom");
    await user.click(sendButton());
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't send the test."));
  });
});
