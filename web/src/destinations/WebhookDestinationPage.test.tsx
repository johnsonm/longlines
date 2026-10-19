import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import { setMobile } from "../test/media";
import {
  getWebhookDestination, rotateSigningSecret, saveWebhookDestination, type Destination, type WebhookDestination, type WebhookSettings,
} from "../lib/api";
import { DEFAULT_WEBHOOK_SETTINGS } from "./webhookModel";
import { WebhookDestinationPage } from "./WebhookDestinationPage";

vi.mock("../lib/api", () => ({
  getWebhookDestination: vi.fn(),
  saveWebhookDestination: vi.fn(),
  rotateSigningSecret: vi.fn(),
}));

// The Payload, Delivery and Preview cards are tested on their own; these stubs expose what the page hands them.
vi.mock("./WebhookPayloadCard", () => ({
  WebhookPayloadCard: ({ settings, onChange }: { settings: WebhookSettings; onChange: (patch: Partial<WebhookSettings>) => void }) => (
    <button type="button" data-testid="payload" data-style={settings.key_style} onClick={() => onChange({ key_style: "camel" })}>Stub camel</button>
  ),
}));
vi.mock("./WebhookDeliveryCard", () => ({
  WebhookDeliveryCard: ({ settings, onChange }: { settings: WebhookSettings; onChange: (patch: Partial<WebhookSettings>) => void }) => (
    <button type="button" data-testid="delivery" data-batch={settings.batch_seconds} onClick={() => onChange({ batch_seconds: 30 })}>
      Stub batch
    </button>
  ),
}));
vi.mock("./WebhookPreviewCard", () => ({
  WebhookPreviewCard: (p: { settings: WebhookSettings; destinationId?: string; path: string; headerLines: string[]; hasUrl: boolean; dirty: boolean }) => (
    <div
      data-testid="preview" data-id={p.destinationId ?? "none"} data-path={p.path} data-headers={p.headerLines.join("|")}
      data-has-url={String(p.hasUrl)} data-dirty={String(p.dirty)} data-style={p.settings.key_style}
    />
  ),
}));

const URL = "https://logger.example.org/hook/abc123";
const MASKED = "https://logger.example.org/hook/••••••";

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "webhook", name: `Dest ${id}`, enabled: true, url_display: MASKED, health: "ok", consecutive_failures: 0,
    last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z", auto_disabled_at: null, ...overrides,
  };
}

const LOADED: WebhookDestination = {
  id: "w1", name: "Logger", enabled: true, url_display: MASKED, settings: { ...DEFAULT_WEBHOOK_SETTINGS, batch_seconds: 10 },
  headers: [{ name: "Authorization" }], secret_rotated_at: null, auto_disabled_at: null,
};

const DESTS = [dest("w1", { name: "Logger" }), dest("d1", { type: "discord" })];

beforeEach(() => {
  vi.mocked(getWebhookDestination).mockReset().mockResolvedValue(LOADED);
  vi.mocked(saveWebhookDestination).mockReset().mockResolvedValue({ id: "w9", signingSecret: "whsec_new" });
  vi.mocked(rotateSigningSecret).mockReset().mockResolvedValue("whsec_rotated");
});

afterEach(() => setMobile(false));

interface Opts {
  id?: string;
  type?: string | null;
  dests?: Destination[];
  loading?: boolean;
  mobile?: boolean;
}

function render({ id, type = null, dests = DESTS, loading = false, mobile = false }: Opts) {
  const reload = vi.fn(() => Promise.resolve());
  const r = renderPage(
    <WebhookDestinationPage id={id} type={type} dests={dests} loading={loading} reload={reload} mobile={mobile} />,
    { route: "/destinations/x" },
  );
  return { ...r, reload };
}

const location = () => screen.getByTestId("location").textContent;
const nameField = () => screen.getByRole("textbox", { name: /Name/ });
const preview = () => screen.getByTestId("preview");

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

  it("sends a Discord id back to the list", () => {
    render({ id: "d1" });
    expect(location()).toBe("/destinations");
    expect(getWebhookDestination).not.toHaveBeenCalled();
  });

  it("needs type=webhook for a new destination", () => {
    render({ type: "discord" });
    expect(location()).toBe("/destinations");
  });

  it("shows the load error, or a generic one", async () => {
    vi.mocked(getWebhookDestination).mockRejectedValueOnce(new Error("Destination not found."));
    const { unmount } = render({ id: "w1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Destination not found.");
    unmount();
    vi.mocked(getWebhookDestination).mockRejectedValueOnce({});
    render({ id: "w1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the destination.");
  });
});

describe("new destination", () => {
  it("starts with the defaults, saves, shows the secret once and leaves on Done", async () => {
    const { user, app, reload } = render({ type: "webhook" });
    expect(screen.getByRole("heading", { name: "New destination" })).toBeInTheDocument();
    expect(screen.getByText("New destination", { selector: "p" })).toBeInTheDocument(); // the breadcrumb
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(
      screen.getByText("Filtering and repeat limits are set on each connection. This page controls where spots are sent and what the request contains."),
    ).toBeInTheDocument();
    expect(screen.getByText("Names are unique. A name can be reused after the destination that has it is deleted.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enabled" })).toBeChecked();
    expect(screen.getByText("A signing secret is created when you add the destination.")).toBeInTheDocument();
    expect(preview()).toHaveAttribute("data-id", "none");
    expect(preview()).toHaveAttribute("data-has-url", "false");
    expect(preview()).toHaveAttribute("data-path", "/");
    const add = screen.getByRole("button", { name: "Add destination" });
    expect(add).toBeDisabled();

    await user.type(nameField(), " Logger ");
    expect(add).toBeDisabled(); // no URL yet
    const url = screen.getByRole("textbox", { name: "Webhook URL" });
    await user.type(url, "http://logger.example.org");
    expect(add).toBeDisabled();
    await user.clear(url);
    await user.type(url, URL);
    expect(preview()).toHaveAttribute("data-has-url", "true");
    expect(preview()).toHaveAttribute("data-path", "/hook/abc123");
    await user.click(screen.getByRole("button", { name: "Add a header" }));
    await user.type(screen.getByRole("textbox", { name: "Header" }), "X-Key");
    expect(add).toBeDisabled(); // a new header needs a value
    await user.clear(screen.getByRole("textbox", { name: "Header" }));
    await user.type(screen.getByRole("textbox", { name: "Value" }), "secret");
    expect(add).toBeDisabled(); // and a value needs a name
    expect(screen.getByText("Give each header a name.")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Value" }));
    await user.type(screen.getByRole("textbox", { name: "Header" }), "X-Key");
    await user.type(screen.getByRole("textbox", { name: "Value" }), "secret");
    expect(preview()).toHaveAttribute("data-headers", "X-Key: ••••••••");
    await user.click(screen.getByTestId("delivery"));
    expect(add).toBeEnabled();

    await user.click(add);
    const dialog = await screen.findByRole("dialog", { name: "Destination added" });
    expect(saveWebhookDestination).toHaveBeenCalledWith({
      name: "Logger", enabled: true, url: URL, settings: { ...DEFAULT_WEBHOOK_SETTINGS, batch_seconds: 30 },
      headers: [{ name: "X-Key", value: "secret" }],
    });
    expect(reload).toHaveBeenCalled();
    expect(within(dialog).getByText("Logger will receive a request every 30 seconds with the matching spots, with the fields you chose."))
      .toBeInTheDocument();
    expect(within(dialog).getByText("whsec_new")).toBeInTheDocument();
    expect(location()).toBe("/destinations/x");
    expect(app.notify).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("checkbox", { name: "I have saved the secret" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(app.notify).toHaveBeenCalledWith("Added Logger");
    expect(location()).toBe("/destinations");
  });

  it("puts the name-taken error on the Name field and other errors in a toast", async () => {
    vi.mocked(saveWebhookDestination)
      .mockRejectedValueOnce(new Error("A destination named Logger already exists. Choose a different name."))
      .mockRejectedValueOnce(new Error("That address is not allowed."))
      .mockRejectedValueOnce({});
    const { user, app } = render({ type: "webhook" });
    await user.type(nameField(), "Logger");
    await user.type(screen.getByRole("textbox", { name: "Webhook URL" }), URL);
    const add = screen.getByRole("button", { name: "Add destination" });
    await user.click(add);
    expect(await screen.findByText("A destination named Logger already exists. Choose a different name.")).toBeInTheDocument();
    expect(nameField()).toHaveAttribute("aria-invalid", "true");
    await user.type(nameField(), "2");
    expect(nameField()).toHaveAttribute("aria-invalid", "false");
    await user.click(add);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("That address is not allowed."));
    await user.click(add);
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't save the destination."));
    expect(location()).toBe("/destinations/x");
  });

  it("leaves with Added when a save returns no secret", async () => {
    vi.mocked(saveWebhookDestination).mockResolvedValue({ id: "w9", signingSecret: null });
    const { user, app } = render({ type: "webhook" });
    await user.type(nameField(), "Logger");
    await user.type(screen.getByRole("textbox", { name: "Webhook URL" }), URL);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(app.notify).toHaveBeenCalledWith("Added Logger");
  });

  it("cancels back to the list", async () => {
    const { user } = render({ type: "webhook" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe("/destinations");
  });
});

describe("editing", () => {
  it("loads the saved destination with the URL masked and saves changes", async () => {
    const { user, app, reload } = render({ id: "w1" });
    expect(await screen.findByRole("heading", { name: "Edit destination" })).toBeInTheDocument();
    expect(getWebhookDestination).toHaveBeenCalledWith("w1");
    expect(screen.getByText("Logger", { selector: "p" })).toBeInTheDocument(); // the breadcrumb
    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Header" })).toHaveValue("Authorization");
    expect(preview()).toHaveAttribute("data-id", "w1");
    expect(preview()).toHaveAttribute("data-path", "/hook/••••••");
    expect(preview()).toHaveAttribute("data-has-url", "true");
    expect(preview()).toHaveAttribute("data-dirty", "false");
    expect(screen.queryByText(/^Paused /)).not.toBeInTheDocument();

    await user.click(screen.getByTestId("payload"));
    expect(preview()).toHaveAttribute("data-dirty", "true");
    expect(preview()).toHaveAttribute("data-style", "camel");
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(location()).toBe("/destinations"));
    // The closed URL field keeps the stored URL, and the saved header keeps its stored value.
    expect(saveWebhookDestination).toHaveBeenCalledWith({
      // Enabled goes as null (keep) because the switch was not touched, so a pause since load is not cleared.
      id: "w1", name: "Logger", enabled: null, url: null, settings: { ...LOADED.settings, key_style: "camel" }, headers: [{ name: "Authorization" }],
    });
    expect(reload).toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith("Saved changes");
  });

  it("keeps the stored URL when Replace URL is left empty, and sends a typed one", async () => {
    const { user } = render({ id: "w1" });
    await user.click(await screen.findByRole("button", { name: "Replace URL" }));
    expect(preview()).toHaveAttribute("data-path", "/hook/••••••");
    const save = screen.getByRole("button", { name: "Save destination" });
    expect(save).toBeEnabled();
    await user.type(screen.getByRole("textbox", { name: "Webhook URL" }), "ftp://x");
    expect(save).toBeDisabled();
    await user.clear(screen.getByRole("textbox", { name: "Webhook URL" }));
    await user.click(save);
    await waitFor(() => expect(saveWebhookDestination).toHaveBeenCalledWith(expect.objectContaining({ url: null })));
  });

  it("sends a replaced URL and previews its path", async () => {
    const { user } = render({ id: "w1" });
    await user.click(await screen.findByRole("button", { name: "Replace URL" }));
    await user.type(screen.getByRole("textbox", { name: "Webhook URL" }), "https://new.example.org/in");
    expect(preview()).toHaveAttribute("data-path", "/in");
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(saveWebhookDestination).toHaveBeenCalledWith(expect.objectContaining({ url: "https://new.example.org/in" })));
  });

  it("removes a header and wants a value for a renamed one", async () => {
    const { user } = render({ id: "w1" });
    const header = await screen.findByRole("textbox", { name: "Header" });
    const save = screen.getByRole("button", { name: "Save destination" });
    await user.type(header, "2");
    expect(save).toBeDisabled();
    expect(screen.getByText("Give the Authorization2 header a value.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove header" }));
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(saveWebhookDestination).toHaveBeenCalledWith(expect.objectContaining({ headers: [] })));
  });

  it("blocks Save on a header with its name cleared, with the inline hint", async () => {
    const { user } = render({ id: "w1" });
    const header = await screen.findByRole("textbox", { name: "Header" });
    const save = screen.getByRole("button", { name: "Save destination" });
    await user.clear(header);
    expect(save).toBeDisabled();
    expect(screen.getByText("Give each header a name.")).toBeInTheDocument();
    await user.type(header, "Authorization");
    expect(save).toBeEnabled();
  });

  it("turns Enabled off and on again without sending it, and sends a real change", async () => {
    const { user } = render({ id: "w1" });
    const enabled = await screen.findByRole("switch", { name: "Enabled" });
    await user.click(enabled);
    await user.click(enabled);
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(saveWebhookDestination).toHaveBeenCalledWith(expect.objectContaining({ enabled: null })));
  });

  it("keeps Save, Cancel and Rotate from running together", async () => {
    let finishRotate: (secret: string) => void = () => undefined;
    vi.mocked(rotateSigningSecret).mockReturnValueOnce(new Promise((resolve) => (finishRotate = resolve)));
    const { user } = render({ id: "w1" });
    const rotate = await screen.findByRole("button", { name: "Rotate" });
    const save = screen.getByRole("button", { name: "Save destination" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await user.click(rotate);
    // A save would leave the page and lose the rotated secret before it is shown.
    expect(save).toBeDisabled();
    expect(cancel).toBeDisabled();
    finishRotate("whsec_rotated");
    expect(await screen.findByRole("dialog", { name: "Signing secret rotated" })).toBeInTheDocument();
    expect(save).toBeEnabled();
    expect(location()).toBe("/destinations/x");

    let finishSave: () => void = () => undefined;
    vi.mocked(saveWebhookDestination).mockReturnValueOnce(new Promise((resolve) => (finishSave = () => resolve({ id: "w1", signingSecret: null }))));
    await user.click(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "I have saved the secret" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(save);
    expect(rotate).toBeDisabled();
    expect(cancel).toBeDisabled();
    finishSave();
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(rotateSigningSecret).toHaveBeenCalledTimes(1);
  });

  it("rotates at once, shows the new secret and keeps unsaved edits on Done", async () => {
    const { user, app } = render({ id: "w1" });
    await user.click(await screen.findByTestId("payload")); // an unsaved edit
    await user.type(nameField(), " edited");
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    const dialog = await screen.findByRole("dialog", { name: "Signing secret rotated" });
    expect(rotateSigningSecret).toHaveBeenCalledWith("w1");
    expect(saveWebhookDestination).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Logger signs requests with this new secret from now on. The old one no longer works.")).toBeInTheDocument();
    expect(within(dialog).getByText("whsec_rotated")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "I have saved the secret" }));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(location()).toBe("/destinations/x");
    expect(app.notify).not.toHaveBeenCalled();
    expect(nameField()).toHaveValue("Logger edited");
    expect(preview()).toHaveAttribute("data-style", "camel");
    expect(screen.getByText(/Rotated 1 minute ago\.$/)).toBeInTheDocument();
  });

  it("toasts a failed rotate", async () => {
    vi.mocked(rotateSigningSecret).mockRejectedValueOnce({});
    const { user, app } = render({ id: "w1" });
    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't rotate the secret."));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("says when and why a paused destination stopped, whatever the pause switch says", async () => {
    vi.mocked(getWebhookDestination).mockResolvedValue({
      ...LOADED, enabled: false, settings: { ...LOADED.settings, pause_after_failures: null },
      auto_disabled_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    });
    const { user } = render({ id: "w1" });
    expect(await screen.findByText(
      "Paused 2 hours ago after repeated failed requests. Spots waiting to be sent were dropped. Turn Enabled on and save to resume.",
    )).toBeInTheDocument();
    const enabled = screen.getByRole("switch", { name: "Enabled" });
    expect(enabled).not.toBeChecked();
    await user.click(enabled);
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(saveWebhookDestination).toHaveBeenCalledWith(expect.objectContaining({ enabled: true })));
  });

  it("shows when the secret was last rotated", async () => {
    vi.mocked(getWebhookDestination).mockResolvedValue({ ...LOADED, secret_rotated_at: new Date(Date.now() - 5 * 86400_000).toISOString() });
    render({ id: "w1" });
    expect(await screen.findByText(/Rotated 5 days ago\.$/)).toBeInTheDocument();
  });

  it("says Save on a phone", async () => {
    setMobile(true);
    render({ id: "w1", mobile: true });
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save destination" })).not.toBeInTheDocument();
  });
});
