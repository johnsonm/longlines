import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { getDiscordDestination, saveDiscordDestination, type Destination, type DiscordDestination, type DiscordSettings } from "../lib/api";
import { DEFAULT_SETTINGS } from "./discordModel";
import { DiscordDestinationPage } from "./DiscordDestinationPage";

vi.mock("../lib/api", () => ({
  getDiscordDestination: vi.fn(),
  saveDiscordDestination: vi.fn(),
}));

// The cards are tested on their own; these stubs expose the props the page hands them.
vi.mock("./DiscordChannelCard", () => ({
  DiscordChannelCard: ({ urlDisplay, url, onUrlChange }: { urlDisplay: string | null; url: string | null; onUrlChange: (url: string | null) => void }) => (
    <div data-testid="channel" data-display={urlDisplay ?? "none"} data-url={url ?? "closed"}>
      <input aria-label="Stub URL" value={url ?? ""} onChange={(e) => onUrlChange(e.target.value)} />
      <button type="button" onClick={() => onUrlChange("")}>Stub replace</button>
    </div>
  ),
}));
vi.mock("./DiscordMessageCard", () => ({
  DiscordMessageCard: ({ settings, onChange }: { settings: DiscordSettings; onChange: (patch: Partial<DiscordSettings>) => void }) => (
    <button type="button" data-testid="message" data-style={settings.style} onClick={() => onChange({ style: "plain" })}>Stub plain</button>
  ),
}));
vi.mock("./DiscordDeliveryCard", () => ({
  DiscordDeliveryCard: ({ settings, onChange }: { settings: DiscordSettings; onChange: (patch: Partial<DiscordSettings>) => void }) => (
    <button type="button" data-testid="delivery" data-batch={settings.batch_seconds} onClick={() => onChange({ batch_seconds: 30 })}>Stub batch</button>
  ),
}));
vi.mock("./DiscordPreviewCard", () => ({
  DiscordPreviewCard: (p: { settings: DiscordSettings; destinationId?: string; name: string; hasUrl: boolean; dirty: boolean }) => (
    <div
      data-testid="preview" data-id={p.destinationId ?? "none"} data-name={p.name} data-has-url={String(p.hasUrl)} data-dirty={String(p.dirty)}
      data-style={p.settings.style}
    />
  ),
}));

const HOOK = "https://discord.com/api/webhooks/123/abc";

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "discord", name: `Dest ${id}`, enabled: true, url_display: "https://discord.com/api/webhooks/…", health: "ok",
    consecutive_failures: 0, last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const LOADED: DiscordDestination = {
  id: "d1", name: "Club channel", enabled: false, url_display: "https://discord.com/api/webhooks/123/…",
  settings: { ...DEFAULT_SETTINGS, card_color: "blue" },
};

const DESTS = [dest("d1", { name: "Club channel" }), dest("p1", { type: "push", url_display: "" }), dest("w1", { type: "webhook" })];

beforeEach(() => {
  vi.mocked(getDiscordDestination).mockReset().mockResolvedValue(LOADED);
  vi.mocked(saveDiscordDestination).mockReset().mockResolvedValue("d9");
});

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
    <DiscordDestinationPage id={id} type={type} dests={dests} loading={loading} reload={reload} mobile={mobile} />,
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

  it("sends a push or webhook id back to the list", () => {
    render({ id: "p1" });
    expect(location()).toBe("/destinations");
    expect(getDiscordDestination).not.toHaveBeenCalled();
  });

  it("needs type=discord for a new destination", () => {
    render({ type: "push" });
    expect(location()).toBe("/destinations");
  });

  it("shows the load error", async () => {
    vi.mocked(getDiscordDestination).mockRejectedValue(new Error("Destination not found."));
    render({ id: "d1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Destination not found.");
  });

  it("falls back to a generic load error", async () => {
    vi.mocked(getDiscordDestination).mockRejectedValue({});
    render({ id: "d1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the destination.");
  });
});

describe("new destination", () => {
  it("starts with the defaults and saves them with the typed name and URL", async () => {
    const { user, app, reload } = render({ type: "discord" });
    expect(screen.getByRole("heading", { name: "New destination" })).toBeInTheDocument();
    expect(screen.getByText("New destination", { selector: "p" })).toBeInTheDocument(); // the breadcrumb
    expect(screen.getByRole("link", { name: "Destinations" })).toBeInTheDocument();
    expect(screen.getByText("Discord channel")).toBeInTheDocument();
    expect(screen.getByText("Filtering and repeat limits are set on each connection. This page controls what the Discord message looks like.")).toBeInTheDocument();
    expect(screen.getByText("Names are unique. A name can be reused after the destination that has it is deleted.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enabled" })).toBeChecked();
    expect(screen.getByTestId("channel")).toHaveAttribute("data-display", "none");
    expect(screen.getByTestId("channel")).toHaveAttribute("data-url", "");
    expect(preview()).toHaveAttribute("data-id", "none");
    expect(preview()).toHaveAttribute("data-has-url", "false");
    const add = screen.getByRole("button", { name: "Add destination" });
    expect(add).toBeDisabled();

    await user.type(nameField(), " Club channel ");
    expect(add).toBeDisabled(); // no URL yet
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), "https://discord.com/channels/1/2");
    expect(add).toBeDisabled(); // a channel link, not a webhook URL
    expect(preview()).toHaveAttribute("data-has-url", "false");
    await user.clear(screen.getByRole("textbox", { name: "Stub URL" }));
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), ` ${HOOK} `);
    expect(preview()).toHaveAttribute("data-has-url", "true");
    expect(add).toBeEnabled();

    await user.click(add);
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(saveDiscordDestination).toHaveBeenCalledWith({ name: "Club channel", enabled: true, url: HOOK, settings: DEFAULT_SETTINGS });
    expect(reload).toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith("Added Club channel");
  });

  it("disables Add destination while the name is blank", async () => {
    const { user } = render({ type: "discord" });
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), HOOK);
    expect(screen.getByRole("button", { name: "Add destination" })).toBeDisabled();
    await user.type(nameField(), "   ");
    expect(screen.getByRole("button", { name: "Add destination" })).toBeDisabled();
  });

  it("shows a taken name on the field and stays", async () => {
    vi.mocked(saveDiscordDestination).mockRejectedValue(new Error("A destination named Club channel already exists. Choose a different name."));
    const { user, app } = render({ type: "discord" });
    await user.type(nameField(), "Club channel");
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), HOOK);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    expect(await screen.findByText("A destination named Club channel already exists. Choose a different name.")).toBeInTheDocument();
    expect(nameField()).toBeInvalid();
    expect(location()).toBe("/destinations/x");
    expect(app.notify).not.toHaveBeenCalled();
    // Typing clears it.
    await user.type(nameField(), "2");
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(screen.getByText("Names are unique. A name can be reused after the destination that has it is deleted.")).toBeInTheDocument();
  });

  it("toasts any other save error and lets the user try again", async () => {
    vi.mocked(saveDiscordDestination).mockRejectedValue(new Error("Use a Discord webhook URL."));
    const { user, app } = render({ type: "discord" });
    await user.type(nameField(), "Club");
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), HOOK);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Use a Discord webhook URL."));
    expect(screen.getByRole("button", { name: "Add destination" })).toBeEnabled();
    expect(location()).toBe("/destinations/x");
  });

  it("falls back to a generic save error", async () => {
    vi.mocked(saveDiscordDestination).mockRejectedValue({});
    const { user, app } = render({ type: "discord" });
    await user.type(nameField(), "Club");
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), HOOK);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't save the destination."));
  });

  it("disables both buttons while saving", async () => {
    let resolve: (id: string) => void = () => {};
    vi.mocked(saveDiscordDestination).mockReturnValue(new Promise((r) => (resolve = r)));
    const { user } = render({ type: "discord" });
    await user.type(nameField(), "Club");
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), HOOK);
    await user.click(screen.getByRole("button", { name: "Add destination" }));
    expect(screen.getByRole("button", { name: "Add destination" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    resolve("d9");
    await waitFor(() => expect(location()).toBe("/destinations"));
  });

  it("cancels back to the list", async () => {
    const { user } = render({ type: "discord" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe("/destinations");
    expect(saveDiscordDestination).not.toHaveBeenCalled();
  });
});

describe("editing", () => {
  it("loads the saved destination and saves changes, keeping the stored URL", async () => {
    const { user, app } = render({ id: "d1" });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Edit destination" })).toBeInTheDocument();
    expect(getDiscordDestination).toHaveBeenCalledWith("d1");
    expect(screen.getByText("Club channel", { selector: "p" })).toBeInTheDocument(); // the breadcrumb
    expect(nameField()).toHaveValue("Club channel");
    expect(screen.getByRole("switch", { name: "Enabled" })).not.toBeChecked();
    expect(screen.getByTestId("channel")).toHaveAttribute("data-display", "https://discord.com/api/webhooks/123/…");
    expect(screen.getByTestId("channel")).toHaveAttribute("data-url", "closed");
    expect(preview()).toHaveAttribute("data-id", "d1");
    expect(preview()).toHaveAttribute("data-name", "Club channel");
    expect(preview()).toHaveAttribute("data-has-url", "true");
    expect(preview()).toHaveAttribute("data-dirty", "false");

    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    expect(preview()).toHaveAttribute("data-dirty", "true");
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(saveDiscordDestination).toHaveBeenCalledWith({
      id: "d1", name: "Club channel", enabled: true, url: null, settings: { ...DEFAULT_SETTINGS, card_color: "blue" },
    });
    expect(app.notify).toHaveBeenCalledWith("Saved changes");
  });

  it("passes setting changes from the cards to the preview and the save", async () => {
    const { user } = render({ id: "d1" });
    await screen.findByRole("heading", { name: "Edit destination" });
    await user.click(screen.getByRole("button", { name: "Stub plain" }));
    await user.click(screen.getByRole("button", { name: "Stub batch" }));
    expect(screen.getByTestId("message")).toHaveAttribute("data-style", "plain");
    expect(screen.getByTestId("delivery")).toHaveAttribute("data-batch", "30");
    expect(preview()).toHaveAttribute("data-style", "plain");
    expect(preview()).toHaveAttribute("data-dirty", "true");
    // The preview keeps the saved name until the save.
    await user.type(nameField(), "!");
    expect(preview()).toHaveAttribute("data-name", "Club channel");
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(saveDiscordDestination).toHaveBeenCalled());
    expect(vi.mocked(saveDiscordDestination).mock.calls[0]![0]).toMatchObject({
      name: "Club channel!", settings: { style: "plain", batch_seconds: 30, card_color: "blue" },
    });
  });

  it("saves a replacement URL", async () => {
    const { user } = render({ id: "d1" });
    await screen.findByRole("heading", { name: "Edit destination" });
    await user.click(screen.getByRole("button", { name: "Stub replace" }));
    expect(screen.getByTestId("channel")).toHaveAttribute("data-url", "");
    // An opened but empty field keeps the stored URL, so nothing changed yet.
    expect(preview()).toHaveAttribute("data-dirty", "false");
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), "https://discord.com/api/webhooks/9/z");
    expect(preview()).toHaveAttribute("data-dirty", "true");
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(saveDiscordDestination).toHaveBeenCalled());
    expect(vi.mocked(saveDiscordDestination).mock.calls[0]![0].url).toBe("https://discord.com/api/webhooks/9/z");
  });

  it("disables saving a replacement that is not a webhook URL", async () => {
    const { user } = render({ id: "d1" });
    await screen.findByRole("heading", { name: "Edit destination" });
    const save = screen.getByRole("button", { name: "Save destination" });
    await user.click(screen.getByRole("button", { name: "Stub replace" }));
    // An empty replacement keeps the stored URL.
    expect(save).toBeEnabled();
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), "https://discord.com/channels/123/456");
    expect(save).toBeDisabled();
    await user.clear(screen.getByRole("textbox", { name: "Stub URL" }));
    await user.type(screen.getByRole("textbox", { name: "Stub URL" }), HOOK);
    expect(save).toBeEnabled();
  });

  it("labels the save button Save on phones", async () => {
    render({ id: "d1", mobile: true });
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save destination" })).not.toBeInTheDocument();
  });

  it("disables saving while the name is blank", async () => {
    const { user } = render({ id: "d1" });
    await screen.findByRole("heading", { name: "Edit destination" });
    await user.clear(nameField());
    expect(screen.getByRole("button", { name: "Save destination" })).toBeDisabled();
  });
});
