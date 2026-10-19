import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import {
  deletePushDevice, getPushDestination, listPushDevices, loadRecentSpots, previewPushNotification, renamePushDevice, savePushDestination,
  sendTest, type Destination, type PushDestination, type PushDevice,
} from "../lib/api";
import { currentEndpoint, disablePush, enablePush, pushSupport } from "../pwa/push";
import { DEFAULT_SETTINGS } from "./pushModel";
import { PushDestinationPage } from "./PushDestinationPage";

vi.mock("../lib/api", () => ({
  deletePushDevice: vi.fn(),
  getPushDestination: vi.fn(),
  listPushDevices: vi.fn(),
  loadRecentSpots: vi.fn(),
  previewPushNotification: vi.fn(),
  renamePushDevice: vi.fn(),
  savePushDestination: vi.fn(),
  sendTest: vi.fn(),
}));
vi.mock("../pwa/push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pwa/push")>()),
  currentEndpoint: vi.fn(),
  deviceAgent: vi.fn(() => "Chrome on Linux"),
  disablePush: vi.fn(),
  enablePush: vi.fn(),
  isIos: vi.fn(() => false),
  pushSupport: vi.fn(),
}));

function device(id: string, overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    id, label: `Device ${id}`, agent: "Chrome on Android", standalone: false, created_at: "2026-10-01T00:00:00Z", last_success_at: null,
    last_error: null, last_error_at: null, blocked_at: null, is_current: false, destination_ids: [], ...overrides,
  };
}

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "push", name: `Dest ${id}`, enabled: true, url_display: "", health: "ok",
    consecutive_failures: 0, last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z", auto_disabled_at: null,
    ...overrides,
  };
}

const LOADED: PushDestination = {
  id: "p1", name: "Phone", enabled: false,
  settings: { ...DEFAULT_SETTINGS, urgency: "high", quiet_from: "22:00:00", quiet_until: "07:00:00" },
  device_ids: ["dev1"],
};

const DESTS = [dest("p1", { name: "Phone" }), dest("w1", { type: "webhook", url_display: "https://example.com/…" })];

const DEVICES = [device("dev1", { label: "Laptop", agent: "Firefox on Linux", is_current: true }), device("dev2", { label: "Phone" })];

beforeEach(() => {
  vi.mocked(getPushDestination).mockReset().mockResolvedValue(LOADED);
  vi.mocked(savePushDestination).mockReset().mockResolvedValue("p9");
  vi.mocked(listPushDevices).mockReset().mockResolvedValue(DEVICES);
  vi.mocked(deletePushDevice).mockReset().mockResolvedValue();
  vi.mocked(renamePushDevice).mockReset().mockResolvedValue();
  vi.mocked(loadRecentSpots).mockReset().mockResolvedValue([]);
  vi.mocked(previewPushNotification).mockReset().mockResolvedValue({ title: "N0CALL · 14.062 MHz · CW", body: "POTA · US-0000", url: "/call/N0CALL", source_url: null });
  vi.mocked(sendTest).mockReset().mockResolvedValue({ status: null });
  vi.mocked(currentEndpoint).mockReset().mockReturnValue("https://fcm.googleapis.com/fcm/send/abc");
  vi.mocked(disablePush).mockReset().mockResolvedValue();
  vi.mocked(enablePush).mockReset().mockResolvedValue("dev3");
  vi.mocked(pushSupport).mockReset().mockResolvedValue("off");
});

interface Opts {
  id?: string;
  type?: string | null;
  dests?: Destination[];
  loading?: boolean;
  mobile?: boolean;
  timezone?: string;
}

function render({ id, type = null, dests = DESTS, loading = false, mobile = false, timezone }: Opts) {
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(
    <PushDestinationPage id={id} type={type} dests={dests} loading={loading} reload={reload} mobile={mobile} />,
    { route: "/destinations/x", app: timezone ? { profile: { id: "u1", callsign: "KK4PWJ", name: "Brad", timezone, utc_times: false, created_at: "" } } : {} },
  );
  return { ...r, reload };
}

const location = () => screen.getByTestId("location").textContent;
const nameField = () => screen.getByRole("textbox", { name: /Name/ });

describe("routing", () => {
  it("waits for destinations to load before giving up on an id", () => {
    render({ id: "nope", loading: true });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(location()).toBe("/destinations/x");
  });

  it("sends an unknown id back to the list", () => {
    render({ id: "nope" });
    expect(location()).toBe("/destinations");
  });

  it("sends a Discord or webhook id back to the list", () => {
    render({ id: "w1" });
    expect(location()).toBe("/destinations");
    expect(getPushDestination).not.toHaveBeenCalled();
  });

  it("needs type=push for a new destination", () => {
    render({ type: "webhook" });
    expect(location()).toBe("/destinations");
  });

  it("shows the load error", async () => {
    vi.mocked(getPushDestination).mockRejectedValue(new Error("Destination not found."));
    render({ id: "p1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Destination not found.");
  });
});

describe("new destination", () => {
  it("starts with the defaults and saves them under the typed name", async () => {
    const { user, app, reload } = render({ type: "push" });
    expect(screen.getByRole("heading", { name: "New destination" })).toBeInTheDocument();
    expect(screen.getByText("Push notification")).toBeInTheDocument();
    expect(screen.getByText("Filtering and repeat limits are set on each connection. This page controls where and how notifications arrive.")).toBeInTheDocument();
    expect(screen.getByText("Names are unique. A name can be reused after the destination that has it is deleted.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enabled" })).toBeChecked();
    const add = screen.getByRole("button", { name: "Add destination" });
    expect(add).toBeDisabled();

    await user.type(nameField(), " POTA phone ");
    await user.click(add);
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(savePushDestination).toHaveBeenCalledWith({ name: "POTA phone", enabled: true, settings: DEFAULT_SETTINGS, device_ids: [] });
    expect(reload).toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith("Added POTA phone");
  });

  it("shows a taken name on the field and stays", async () => {
    vi.mocked(savePushDestination).mockRejectedValue(new Error("A destination named Phone already exists. Choose a different name."));
    const { user, app } = render({ type: "push" });
    await user.type(nameField(), "Phone");
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    expect(await screen.findByText("A destination named Phone already exists. Choose a different name.")).toBeInTheDocument();
    expect(nameField()).toBeInvalid();
    expect(location()).toBe("/destinations/x");
    expect(app.notify).not.toHaveBeenCalled();
    // Typing clears it.
    await user.type(nameField(), "2");
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
  });

  it("toasts any other save error", async () => {
    vi.mocked(savePushDestination).mockRejectedValue(new Error("Not signed in."));
    const { user, app } = render({ type: "push" });
    await user.type(nameField(), "Phone");
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Not signed in."));
    expect(screen.getByRole("button", { name: "Add destination" })).toBeEnabled();
  });

  it("cancels back to the list", async () => {
    const { user } = render({ type: "push" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe("/destinations");
  });
});

describe("editing", () => {
  it("loads the saved destination and saves changes", async () => {
    const { user, app } = render({ id: "p1" });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Edit destination" })).toBeInTheDocument();
    expect(getPushDestination).toHaveBeenCalledWith("p1");
    expect(screen.getByText("Phone", { selector: "p" })).toBeInTheDocument(); // the breadcrumb
    expect(nameField()).toHaveValue("Phone");
    expect(screen.getByRole("switch", { name: "Enabled" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Urgency" })).toHaveTextContent("High");

    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(savePushDestination).toHaveBeenCalledWith({
      id: "p1", name: "Phone", enabled: true, settings: { ...DEFAULT_SETTINGS, urgency: "high" }, device_ids: ["dev1"],
    });
    expect(app.notify).toHaveBeenCalledWith("Saved changes");
  });

  it("leaves out a member the account no longer has when saving", async () => {
    vi.mocked(getPushDestination).mockResolvedValue({ ...LOADED, device_ids: ["dev1", "gone"] });
    const { user } = render({ id: "p1" });
    await screen.findByRole("heading", { name: "Edit destination" });
    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(savePushDestination).toHaveBeenCalled());
    expect(vi.mocked(savePushDestination).mock.calls[0]![0].device_ids).toEqual(["dev1"]);
  });

  it("says Save on phones", async () => {
    setMobile(true);
    render({ id: "p1", mobile: true });
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save destination" })).not.toBeInTheDocument();
  });
});

describe("devices", () => {
  it("lists the account's devices with the members checked and saves the picks", async () => {
    const { user } = render({ id: "p1" });
    expect(await screen.findByRole("checkbox", { name: "Send to Laptop" })).toBeChecked();
    expect(listPushDevices).toHaveBeenCalledWith("https://fcm.googleapis.com/fcm/send/abc");
    expect(screen.getByRole("checkbox", { name: "Send to Phone" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Send to Phone" }));
    await user.click(screen.getByRole("checkbox", { name: "Send to Laptop" }));
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(savePushDestination).toHaveBeenCalled());
    expect(vi.mocked(savePushDestination).mock.calls[0]![0].device_ids).toEqual(["dev2"]);
  });

  it("toasts when the devices cannot load and shows the error, not the empty state", async () => {
    vi.mocked(listPushDevices).mockRejectedValue(new Error("Couldn't load your devices."));
    const { app } = render({ type: "push" });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't load your devices."));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load your devices.");
    expect(screen.queryByText("No devices yet")).not.toBeInTheDocument();
  });

  it("keeps the members when saving after the devices failed to load", async () => {
    vi.mocked(listPushDevices).mockRejectedValue(new Error("Couldn't load your devices."));
    const { user, app } = render({ id: "p1" });
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't load your devices."));
    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(savePushDestination).toHaveBeenCalled());
    expect(vi.mocked(savePushDestination).mock.calls[0]![0].device_ids).toEqual(["dev1"]);
  });

  it("checks a device added from the dialog", async () => {
    vi.mocked(listPushDevices).mockResolvedValueOnce([]);
    const { user } = render({ type: "push" });
    await user.click(await screen.findByRole("button", { name: "Add this device" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a device" });
    vi.mocked(listPushDevices).mockResolvedValue([...DEVICES, device("dev3", { label: "Chrome on Linux", agent: "Chrome on Linux", is_current: true })]);
    const enable = within(dialog).getByRole("button", { name: "Enable notifications" });
    await waitFor(() => expect(enable).toBeEnabled());
    await user.click(enable);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(enablePush).toHaveBeenCalledWith("Chrome on Linux");
    expect(await screen.findByRole("checkbox", { name: "Send to Chrome on Linux" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Send to Phone" })).not.toBeChecked();

    await user.type(nameField(), "Here");
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(savePushDestination).toHaveBeenCalled());
    expect(vi.mocked(savePushDestination).mock.calls[0]![0].device_ids).toEqual(["dev3"]);
  });

  it("renames a device and reloads the list", async () => {
    const { user, app } = render({ id: "p1" });
    await user.click(await screen.findByRole("button", { name: "Rename Phone" }));
    const dialog = screen.getByRole("dialog", { name: "Rename device" });
    const field = within(dialog).getByRole("textbox", { name: "Device name" });
    await user.clear(field);
    await user.type(field, "Pixel");
    vi.mocked(listPushDevices).mockResolvedValue([DEVICES[0]!, device("dev2", { label: "Pixel" })]);
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(renamePushDevice).toHaveBeenCalledWith("dev2", "Pixel");
    expect(app.notify).toHaveBeenCalledWith("Renamed Pixel");
    expect(await screen.findByRole("checkbox", { name: "Send to Pixel" })).toBeInTheDocument();
  });

  it("removes another device without touching this browser", async () => {
    const { user, app } = render({ id: "p1" });
    const remove = await screen.findByRole("button", { name: "Remove Phone" });
    vi.mocked(listPushDevices).mockResolvedValue([DEVICES[0]!]);
    await user.click(remove);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Removed Phone"));
    expect(deletePushDevice).toHaveBeenCalledWith("dev2");
    expect(disablePush).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Send to Phone" })).not.toBeInTheDocument());
  });

  it("removing this device also turns its notifications off and unchecks it", async () => {
    const { user, app } = render({ id: "p1" });
    const remove = await screen.findByRole("button", { name: "Remove Laptop" });
    vi.mocked(listPushDevices).mockResolvedValue([DEVICES[1]!]);
    await user.click(remove);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Removed Laptop"));
    expect(deletePushDevice).toHaveBeenCalledWith("dev1");
    expect(disablePush).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(savePushDestination).toHaveBeenCalled());
    expect(vi.mocked(savePushDestination).mock.calls[0]![0].device_ids).toEqual([]);
  });

  it("toasts when removing fails", async () => {
    vi.mocked(deletePushDevice).mockRejectedValue(new Error("Device not found."));
    const { user, app } = render({ id: "p1" });
    await user.click(await screen.findByRole("button", { name: "Remove Phone" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Device not found."));
    expect(screen.getByRole("checkbox", { name: "Send to Phone" })).toBeInTheDocument();
  });

  it("opens the dialog full screen on phones", async () => {
    setMobile(true);
    const { user } = render({ id: "p1", mobile: true });
    await user.click(await screen.findByRole("button", { name: "Add a device" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a device" });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("notification content", () => {
  it("round-trips the field picks and text settings into the saved input, with the preview following", async () => {
    const { user } = render({ type: "push" });
    await user.type(nameField(), "Phone");
    await user.click(screen.getByRole("button", { name: "Move Mode up" }));
    await user.click(screen.getByRole("button", { name: "Remove State" }));
    await user.click(screen.getByRole("switch", { name: "Show field names" }));
    await user.click(screen.getByRole("combobox", { name: "Separate body fields with" }));
    await user.click(screen.getByRole("option", { name: "A comma" }));
    await user.click(screen.getByRole("combobox", { name: "When tapped, open" }));
    await user.click(screen.getByRole("option", { name: "Source site" }));
    await user.click(screen.getByRole("switch", { name: "Show action buttons" }));
    await waitFor(() => expect(previewPushNotification).toHaveBeenLastCalledWith(["callsign", "mode", "frequency"], ["source", "reference", "place_name"], true, "comma", null));
    expect(await screen.findAllByText("N0CALL · 14.062 MHz · CW")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(savePushDestination).toHaveBeenCalled());
    expect(vi.mocked(savePushDestination).mock.calls[0]![0].settings).toEqual({
      ...DEFAULT_SETTINGS,
      title_fields: ["callsign", "mode", "frequency"], body_fields: ["source", "reference", "place_name"],
      show_field_names: true, body_separator: "comma", tap_target: "source", action_buttons: false,
    });
  });

  it("enables Send test only for a saved destination with members and no changes", async () => {
    const { user, app } = render({ id: "p1" });
    const button = await screen.findByRole("button", { name: "Send test notification" });
    expect(button).toBeEnabled();
    expect(screen.getByText("Sends this example to the 1 selected device.")).toBeInTheDocument();
    await user.click(button);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Test spot sent to Phone"));
    expect(sendTest).toHaveBeenCalledWith("p1", null);
    await user.click(screen.getByRole("switch", { name: "Sound and vibration" }));
    expect(button).toBeDisabled();
    expect(screen.getByText("Save your changes to send a test.")).toBeInTheDocument();
  });
});

describe("delivery settings", () => {
  it("round-trips every control into the saved input", async () => {
    const { user } = render({ type: "push", timezone: "America/New_York" });
    expect(screen.getByText("How notifications behave on the device")).toBeInTheDocument();
    expect(screen.getByText("High can wake a sleeping phone. Normal fits most connections.")).toBeInTheDocument();
    expect(screen.getByText("Old spots are rarely useful. Late notifications are dropped, not queued.")).toBeInTheDocument();
    expect(screen.getByText("Uses your account time zone, America/New_York.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Drop if the device is offline for" })).toHaveTextContent("30 minutes");

    await user.type(nameField(), "Phone");
    await user.click(screen.getByRole("combobox", { name: "Urgency" }));
    await user.click(screen.getByRole("option", { name: "High" }));
    await user.click(screen.getByRole("combobox", { name: "Drop if the device is offline for" }));
    await user.click(screen.getByRole("option", { name: "4 hours" }));
    await user.click(screen.getByRole("switch", { name: "Replace the earlier notification for the same station" }));
    await user.click(screen.getByRole("switch", { name: "Sound and vibration" }));

    // The quiet row is off until the switch is on.
    const from = screen.getByLabelText("From");
    const until = screen.getByLabelText("Until");
    expect(from).toBeDisabled();
    expect(until).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "During quiet hours" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("switch", { name: "Quiet hours" }));
    expect(from).toBeEnabled();
    expect(from).toHaveValue("22:00");
    expect(until).toHaveValue("07:00");
    fireEvent.change(from, { target: { value: "23:30" } });
    fireEvent.change(until, { target: { value: "06:15" } });
    await user.click(screen.getByRole("combobox", { name: "During quiet hours" }));
    await user.click(screen.getByRole("option", { name: "Don't send" }));

    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(savePushDestination).toHaveBeenCalled());
    expect(vi.mocked(savePushDestination).mock.calls[0]![0].settings).toEqual({
      ...DEFAULT_SETTINGS,
      urgency: "high", ttl_seconds: 14400, replace_same_station: false, sound: false,
      quiet_enabled: true, quiet_from: "23:30", quiet_until: "06:15", quiet_mode: "skip",
    });
  });
});
