import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import { getPushDestination, savePushDestination, type Destination, type PushDestination } from "../lib/api";
import { DEFAULT_SETTINGS } from "./pushModel";
import { PushDestinationPage } from "./PushDestinationPage";

vi.mock("../lib/api", () => ({
  getPushDestination: vi.fn(),
  savePushDestination: vi.fn(),
}));

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "push", name: `Dest ${id}`, enabled: true, url_display: "", health: "ok",
    consecutive_failures: 0, last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const LOADED: PushDestination = {
  id: "p1", name: "Phone", enabled: false,
  settings: { ...DEFAULT_SETTINGS, urgency: "high", quiet_from: "22:00:00", quiet_until: "07:00:00" },
  device_ids: ["dev1"],
};

const DESTS = [dest("p1", { name: "Phone" }), dest("w1", { type: "webhook", url_display: "https://example.com/…" })];

beforeEach(() => {
  vi.mocked(getPushDestination).mockReset().mockResolvedValue(LOADED);
  vi.mocked(savePushDestination).mockReset().mockResolvedValue("p9");
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
    expect(screen.getByText("Filtering and repeat limits are set on each subscription. This page controls where and how notifications arrive.")).toBeInTheDocument();
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

  it("says Save on phones", async () => {
    setMobile(true);
    render({ id: "p1", mobile: true });
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save destination" })).not.toBeInTheDocument();
  });
});

describe("delivery settings", () => {
  it("round-trips every control into the saved input", async () => {
    const { user } = render({ type: "push", timezone: "America/New_York" });
    expect(screen.getByText("How notifications behave on the device")).toBeInTheDocument();
    expect(screen.getByText("High can wake a sleeping phone. Normal fits most subscriptions.")).toBeInTheDocument();
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
