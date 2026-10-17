import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import type { PushDevice } from "../lib/api";
import { deviceCaption } from "./cardMeta";
import { DevicesCard } from "./DevicesCard";

function device(id: string, overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    id, label: `Device ${id}`, agent: "Chrome on Android", standalone: false, created_at: "2026-10-01T00:00:00Z", last_success_at: null,
    last_error: null, last_error_at: null, blocked_at: null, is_current: false, destination_ids: [], ...overrides,
  };
}

function render(devices: PushDevice[] | null, checked: string[] = [], busy = false) {
  const handlers = { onToggle: vi.fn(), onAdd: vi.fn(), onRename: vi.fn(), onRemove: vi.fn() };
  const r = renderPage(<DevicesCard devices={devices} checked={checked} busy={busy} {...handlers} />);
  return { ...r, ...handlers };
}

describe("deviceCaption", () => {
  const now = new Date("2026-10-17T12:00:00Z");

  it("describes the device and its last delivery", () => {
    expect(deviceCaption(device("a"), now)).toBe("Chrome on Android · no deliveries yet");
    expect(deviceCaption(device("a", { standalone: true, last_success_at: "2026-10-17T11:55:00Z" }), now))
      .toBe("Chrome on Android, installed app · last delivery 5 minutes ago");
    expect(deviceCaption(device("a", { agent: "Safari on iPhone", blocked_at: "2026-10-17T10:00:00Z", last_success_at: "2026-10-17T09:00:00Z" }), now))
      .toBe("Safari on iPhone · notifications blocked in this browser");
  });
});

describe("DevicesCard", () => {
  it("shows a progress bar while the devices load", () => {
    render(null);
    expect(screen.getByText("Pick which devices receive notifications. Each device is a browser you have allowed.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("shows the empty state with both ways to add", async () => {
    const { user, onAdd } = render([]);
    expect(screen.getByText("No devices yet")).toBeInTheDocument();
    expect(screen.getByText("Add the device you are on now, or open Long Lines on your phone to add it. A destination needs at least one device to deliver."))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add this device" }));
    await user.click(screen.getByRole("button", { name: "Add my phone" }));
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Add a device" })).not.toBeInTheDocument();
  });

  it("lists every device in its state", () => {
    render(
      [
        device("a", { label: "Laptop", agent: "Firefox on Linux", is_current: true }),
        device("b", { label: "Phone", standalone: true, last_success_at: new Date(Date.now() - 3 * 60_000).toISOString() }),
        device("c", { label: "Old tablet", agent: "Safari on iPad", blocked_at: "2026-10-16T00:00:00Z" }),
      ],
      ["b"],
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("This device")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Firefox on Linux · no deliveries yet")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("checkbox", { name: "Send to Laptop" })).not.toBeChecked();
    expect(within(rows[1]!).getByText("Chrome on Android, installed app · last delivery 3 minutes ago")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("checkbox", { name: "Send to Phone" })).toBeChecked();
    expect(within(rows[2]!).getByText("Blocked")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Safari on iPad · notifications blocked in this browser")).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("checkbox", { name: "Send to Old tablet" })).toBeDisabled();
    expect(screen.queryByText("No devices yet")).not.toBeInTheDocument();
  });

  it("reports toggles, rename, remove and add", async () => {
    const devices = [device("a", { label: "Laptop" }), device("b", { label: "Phone" })];
    const { user, onToggle, onRename, onRemove, onAdd } = render(devices, ["a"]);
    await user.click(screen.getByRole("checkbox", { name: "Send to Laptop" }));
    expect(onToggle).toHaveBeenCalledWith("a", false);
    await user.click(screen.getByRole("checkbox", { name: "Send to Phone" }));
    expect(onToggle).toHaveBeenCalledWith("b", true);
    await user.click(screen.getByRole("button", { name: "Rename Phone" }));
    expect(onRename).toHaveBeenCalledWith(devices[1]);
    await user.click(screen.getByRole("button", { name: "Remove Laptop" }));
    expect(onRemove).toHaveBeenCalledWith(devices[0]);
    await user.click(screen.getByRole("button", { name: "Add a device" }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("disables the row controls while busy", () => {
    render([device("a", { label: "Laptop" })], [], true);
    expect(screen.getByRole("checkbox", { name: "Send to Laptop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename Laptop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Laptop" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add a device" })).toBeDisabled();
  });
});
