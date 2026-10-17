import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage, wrap } from "../test/render";
import { deviceAgent, enablePush, isIos, pushSupport, type PushSupport } from "../pwa/push";
import { AddDeviceDialog } from "./AddDeviceDialog";

vi.mock("../pwa/push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pwa/push")>()),
  deviceAgent: vi.fn(),
  enablePush: vi.fn(),
  isIos: vi.fn(),
  pushSupport: vi.fn(),
}));
vi.mock("../lib/api", () => ({}));

beforeEach(() => {
  vi.mocked(deviceAgent).mockReset().mockReturnValue("Chrome on Linux");
  vi.mocked(enablePush).mockReset().mockResolvedValue("dev9");
  vi.mocked(isIos).mockReset().mockReturnValue(false);
  vi.mocked(pushSupport).mockReset().mockResolvedValue("off");
});

function render(support: PushSupport = "off", fullScreen = false) {
  vi.mocked(pushSupport).mockResolvedValue(support);
  const onClose = vi.fn();
  const onAdded = vi.fn();
  const r = renderPage(<AddDeviceDialog open fullScreen={fullScreen} onClose={onClose} onAdded={onAdded} />);
  return { ...r, onClose, onAdded };
}

const enable = () => screen.getByRole("button", { name: "Enable notifications" });

describe("AddDeviceDialog", () => {
  it("prefills the device name and turns notifications on under the typed name", async () => {
    const { user, app, onAdded } = render();
    expect(screen.getByRole("dialog", { name: "Add a device" })).toBeInTheDocument();
    expect(screen.getByText("Chrome on Linux")).toBeInTheDocument();
    expect(screen.getByText("Your browser will ask for permission. Choose Allow. You can change this later in the browser site settings.")).toBeInTheDocument();
    expect(screen.getByText("Go to longlines.io and sign in as KK4PWJ.")).toBeInTheDocument();
    expect(screen.getByText("Allow notifications when asked. The device appears here when it is ready.")).toBeInTheDocument();
    expect(screen.getByText("On iPhone and iPad, first add Long Lines to the Home Screen from the Share menu. Safari only allows notifications for installed web apps."))
      .toBeInTheDocument();
    const name = screen.getByRole("textbox", { name: "Device name" });
    expect(name).toHaveValue("Chrome on Linux");
    await waitFor(() => expect(enable()).toBeEnabled());

    await user.clear(name);
    await user.type(name, "Shack PC");
    await user.click(enable());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("dev9"));
    expect(enablePush).toHaveBeenCalledWith("Shack PC");
    expect(app.notify).toHaveBeenCalledWith("Notifications turned on");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("is usable again when reopened after a successful enable", async () => {
    const { user, app, onAdded, rerender, onClose } = render();
    await waitFor(() => expect(enable()).toBeEnabled());
    await user.click(enable());
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("dev9"));
    expect(enable()).toBeDisabled();
    rerender(wrap(<AddDeviceDialog open={false} fullScreen={false} onClose={onClose} onAdded={onAdded} />, app));
    rerender(wrap(<AddDeviceDialog open fullScreen={false} onClose={onClose} onAdded={onAdded} />, app));
    await waitFor(() => expect(enable()).toBeEnabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("shows why enabling failed and stays open", async () => {
    vi.mocked(enablePush).mockRejectedValue(new Error("Notifications are blocked for Long Lines. Allow them in your browser's site settings, then reload this page."));
    const { user, onAdded } = render();
    await waitFor(() => expect(enable()).toBeEnabled());
    await user.click(enable());
    expect(await screen.findByText(/^Notifications are blocked for Long Lines\./)).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();
    expect(enable()).toBeEnabled();
  });

  it("replaces the button with the sentence when denied or unsupported", async () => {
    render("denied");
    expect(await screen.findByText("Notifications are blocked for Long Lines. Allow them in your browser's site settings, then reload this page.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable notifications" })).not.toBeInTheDocument();
  });

  it("says so when the browser cannot push", async () => {
    render("unsupported");
    expect(await screen.findByText("This browser can't receive push notifications.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable notifications" })).not.toBeInTheDocument();
  });

  it("shows the Home Screen steps on an iPhone that is not installed", async () => {
    vi.mocked(isIos).mockReturnValue(true);
    vi.mocked(deviceAgent).mockReturnValue("Safari on iPhone");
    render("ios-needs-install", true);
    expect(await screen.findByText("Add Long Lines to your Home Screen first")).toBeInTheDocument();
    expect(screen.getByText("Safari on iPhone only allows notifications for web apps added to the Home Screen.")).toBeInTheDocument();
    expect(screen.getByText("Tap Share")).toBeInTheDocument();
    expect(screen.getByText("The square with an arrow, in the Safari toolbar.")).toBeInTheDocument();
    expect(screen.getByText("Choose Add to Home Screen")).toBeInTheDocument();
    expect(screen.getByText("Then tap Add.")).toBeInTheDocument();
    expect(screen.getByText("Open Long Lines from the Home Screen")).toBeInTheDocument();
    expect(screen.getByText("Sign in, go to Destinations, and choose Add this device.")).toBeInTheDocument();
    expect(enable()).toBeDisabled();
    expect(screen.getByText("Available once Long Lines is opened from the Home Screen.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Device name" })).not.toBeInTheDocument();
    // Full screen on a phone: the title gets a close button.
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("closes from Cancel and the phone close button", async () => {
    const { user, onClose } = render("off", true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
