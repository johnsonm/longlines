import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { loadRecentSpots, previewPushNotification, sendTest, type PushPreview, type PushSettings, type RecentSpot } from "../lib/api";
import { DEFAULT_SETTINGS, MOCKUP_CAPTIONS } from "./pushModel";
import { PushPreviewCard } from "./PushPreviewCard";

vi.mock("../lib/api", () => ({
  loadRecentSpots: vi.fn(),
  previewPushNotification: vi.fn(),
  sendTest: vi.fn(),
}));

const spot = (id: number, source: string, minutesAgo: number, overrides: Partial<RecentSpot> = {}): RecentSpot => ({
  id, source, callsign: `K${id}ABC`, frequency_khz: 14062, mode: "cw", pota_reference: source === "pota" ? "US-0817" : null,
  sota_summit_ref: source === "sotawatch" ? "W4C/CM-001" : null, wwff_reference: null, band: "20m", mode_family: "cw", comment: null,
  spotter: "W1AW", pota_location: null, pota_park_name: null, wwff_reference_name: null,
  spot_time: new Date(Date.parse("2026-10-17T12:00:00Z") - minutesAgo * 60_000).toISOString(), ...overrides,
});

const PREVIEW: PushPreview = { title: "N0CALL · 14.062 MHz · CW", body: "POTA · US-0000 · Test Park · TEST", url: "/call/N0CALL", source_url: "https://pota.app/#/park/US-0000" };

beforeEach(() => {
  vi.mocked(loadRecentSpots).mockReset().mockImplementation((source) =>
    Promise.resolve(
      source === "pota" ? [spot(1, "pota", 1), spot(2, "pota", 30)] : source === "sotawatch" ? [spot(3, "sotawatch", 5)] : source === "dxcluster" ? [spot(4, "dxcluster", 2, { mode: null })] : [],
    ),
  );
  vi.mocked(previewPushNotification).mockReset().mockResolvedValue(PREVIEW);
  vi.mocked(sendTest).mockReset().mockResolvedValue();
});

interface Opts {
  settings?: Partial<PushSettings>;
  destinationId?: string;
  savedDeviceCount?: number;
  dirty?: boolean;
}

function render({ settings = {}, destinationId, savedDeviceCount = 0, dirty = false }: Opts = {}) {
  return renderPage(
    <PushPreviewCard settings={{ ...DEFAULT_SETTINGS, ...settings }} destinationId={destinationId} name="Phone" savedDeviceCount={savedDeviceCount} dirty={dirty} />,
  );
}

const figure = (name: string) => within(screen.getByRole("figure", { name }));
const sendButton = () => screen.getByRole("button", { name: "Send test notification" });

describe("PushPreviewCard", () => {
  it("previews the sample spot in all three mock-ups with SQL's text", async () => {
    render();
    expect(screen.getByText("Preview")).toBeInTheDocument();
    await waitFor(() => expect(previewPushNotification).toHaveBeenCalledWith(DEFAULT_SETTINGS.title_fields, DEFAULT_SETTINGS.body_fields, false, "dot", null));
    for (const name of ["Android notification", "iPhone notification", "Desktop notification"]) {
      expect(await figure(name).findByText("N0CALL · 14.062 MHz · CW")).toBeInTheDocument();
      expect(figure(name).getByText("POTA · US-0000 · Test Park · TEST")).toBeInTheDocument();
    }
    for (const caption of Object.values(MOCKUP_CAPTIONS)) expect(screen.getByText(caption)).toBeInTheDocument();
    // Action buttons on Android and desktop, labelled for the sample's source; never on iPhone.
    expect(figure("Android notification").getByText("Open profile")).toBeInTheDocument();
    expect(figure("Android notification").getByText("Open on POTA")).toBeInTheDocument();
    expect(figure("Desktop notification").getByText("Open on POTA")).toBeInTheDocument();
    expect(figure("iPhone notification").queryByText("Open profile")).not.toBeInTheDocument();
  });

  it("hides the action buttons when the destination does not show them, and the source one without a source page", async () => {
    vi.mocked(previewPushNotification).mockResolvedValue({ ...PREVIEW, source_url: null });
    const first = render();
    await figure("Android notification").findByText("N0CALL · 14.062 MHz · CW");
    expect(figure("Android notification").getByText("Open profile")).toBeInTheDocument();
    expect(figure("Android notification").queryByText(/^Open on/)).not.toBeInTheDocument();
    first.unmount();
    render({ settings: { action_buttons: false } });
    await figure("Android notification").findByText("N0CALL · 14.062 MHz · CW");
    expect(figure("Android notification").queryByText("Open profile")).not.toBeInTheDocument();
  });

  it("offers the newest recent spots across sources and previews the chosen one", async () => {
    const { user } = render({ settings: { show_field_names: true, body_separator: "comma", title_fields: ["callsign"] } });
    await waitFor(() => expect(loadRecentSpots).toHaveBeenCalledTimes(4));
    expect(vi.mocked(loadRecentSpots).mock.calls.map((c) => c[0])).toEqual(["pota", "sotawatch", "dxcluster", "wwff"]);
    await user.click(screen.getByRole("combobox", { name: "Preview with this spot" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(5));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Sample spot", "K1ABC, POTA US-0817, 14062 CW", "K4ABC, DX Cluster, 14062", "K3ABC, SOTAwatch W4C/CM-001, 14062 CW", "K2ABC, POTA US-0817, 14062 CW",
    ]);
    vi.mocked(previewPushNotification).mockResolvedValue({ ...PREVIEW, title: "K3ABC", source_url: "https://sotl.as/summits/W4C/CM-001" });
    await user.click(screen.getByRole("option", { name: "K3ABC, SOTAwatch W4C/CM-001, 14062 CW" }));
    await waitFor(() => expect(previewPushNotification).toHaveBeenLastCalledWith(["callsign"], DEFAULT_SETTINGS.body_fields, true, "comma", 3));
    expect(await figure("Android notification").findByText("K3ABC")).toBeInTheDocument();
    expect(figure("Android notification").getByText("Open on SOTAwatch")).toBeInTheDocument();
  });

  it("shows the preview error", async () => {
    vi.mocked(previewPushNotification).mockRejectedValue(new Error("Pick 1 to 4 fields for the title."));
    render();
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick 1 to 4 fields for the title.");
  });

  it("explains why a test cannot be sent", () => {
    const first = render();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Add a device to send a test.")).toBeInTheDocument();
    first.unmount();
    const second = render({ destinationId: "d1", savedDeviceCount: 2, dirty: true });
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("Save your changes to send a test.")).toBeInTheDocument();
    second.unmount();
    render({ destinationId: "d1", savedDeviceCount: 1 });
    expect(sendButton()).toBeEnabled();
    expect(screen.getByText("Sends this example to the 1 selected device.")).toBeInTheDocument();
  });

  it("sends the test with the chosen spot and toasts", async () => {
    const { user, app } = render({ destinationId: "d1", savedDeviceCount: 2 });
    expect(screen.getByText("Sends this example to the 2 selected devices.")).toBeInTheDocument();
    await user.click(sendButton());
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Phone"));
    expect(sendTest).toHaveBeenCalledWith("d1", null);

    await user.click(screen.getByRole("combobox", { name: "Preview with this spot" }));
    await user.click(await screen.findByRole("option", { name: "K1ABC, POTA US-0817, 14062 CW" }));
    vi.mocked(sendTest).mockRejectedValue(new Error("No devices can receive it."));
    await user.click(sendButton());
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("No devices can receive it."));
    expect(sendTest).toHaveBeenLastCalledWith("d1", 1);
  });
});
