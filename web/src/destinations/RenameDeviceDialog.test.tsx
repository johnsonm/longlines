import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { renamePushDevice, type PushDevice } from "../lib/api";
import { RenameDeviceDialog } from "./RenameDeviceDialog";

vi.mock("../lib/api", () => ({ renamePushDevice: vi.fn() }));

const DEVICE: PushDevice = {
  id: "dev1", label: "Phone", agent: "Chrome on Android", standalone: false, created_at: "2026-10-01T00:00:00Z", last_success_at: null,
  last_error: null, last_error_at: null, blocked_at: null, is_current: false, destination_ids: [],
};

beforeEach(() => {
  vi.mocked(renamePushDevice).mockReset().mockResolvedValue();
});

function render() {
  const onClose = vi.fn();
  const onRenamed = vi.fn();
  const r = renderPage(<RenameDeviceDialog device={DEVICE} onClose={onClose} onRenamed={onRenamed} />);
  return { ...r, onClose, onRenamed };
}

describe("RenameDeviceDialog", () => {
  it("renames the device and toasts", async () => {
    const { user, app, onRenamed } = render();
    const field = screen.getByRole("textbox", { name: "Device name" });
    expect(field).toHaveValue("Phone");
    expect(screen.getByText("Chrome on Android")).toBeInTheDocument();
    await user.clear(field);
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    await user.type(field, " Pixel ");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalled());
    expect(renamePushDevice).toHaveBeenCalledWith("dev1", "Pixel");
    expect(app.notify).toHaveBeenCalledWith("Renamed Pixel");
  });

  it("shows the error on the field", async () => {
    vi.mocked(renamePushDevice).mockRejectedValue(new Error("Device not found."));
    const { user, onRenamed } = render();
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Device not found.")).toBeInTheDocument();
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it("cancels", async () => {
    const { user, onClose } = render();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
