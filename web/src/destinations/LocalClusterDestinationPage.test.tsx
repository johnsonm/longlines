import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { renderPage } from "../test/render";
import {
  getLocalClusterDestination, loadRelayTokens, previewLocalClusterLine, saveLocalClusterDestination, type Destination, type LocalClusterPreview,
  type RelayToken,
} from "../lib/api";
import { RELAY_DOWNLOAD_URL } from "../tokens/model";
import { LocalClusterDestinationPage } from "./LocalClusterDestinationPage";

vi.mock("../lib/api", () => ({
  getLocalClusterDestination: vi.fn(),
  loadRelayTokens: vi.fn(),
  previewLocalClusterLine: vi.fn(),
  saveLocalClusterDestination: vi.fn(),
}));

function dest(id: string, overrides: Partial<Destination> = {}): Destination {
  return {
    id, user_id: "u1", type: "local_cluster", name: `Dest ${id}`, enabled: true, url_display: "Long Lines Relay", health: "ok",
    consecutive_failures: 0, last_success_at: null, last_error: null, last_error_at: null, created_at: "2026-10-01T00:00:00Z", auto_disabled_at: null,
    ...overrides,
  };
}

function relay(id: string, overrides: Partial<RelayToken> = {}): RelayToken {
  return {
    id, user_id: "u1", token_prefix: "llr_abc", device_name: `Relay ${id}`, client_version: "0.2.0", scopes: ["contacts:write", "spots:read"],
    created_at: "2026-10-28T00:00:00Z", last_used_at: null, platform: "windows", cluster_connected_at: null, ...overrides,
  };
}

const SHACK = relay("r1", { device_name: "Shack PC", cluster_connected_at: "2026-10-28T21:00:00Z" });
const LAPTOP = relay("r2", { device_name: "Laptop" });
const OLD = relay("r0", { device_name: "Old PC", scopes: ["contacts:write"], platform: null });

/** preview_local_cluster_line's answer for the sample spot with the default fields (pinned against the local stack). */
const PREVIEW: LocalClusterPreview = {
  line: "DX de W4DOG:     14062.0  K4ABC        CW POTA K-0039                 2114Z", spotter: "W4DOG", frequency_khz: 14062,
  callsign: "K4ABC", comment: "CW POTA K-0039", time_utc: "2114",
};

const DESTS = [dest("l1", { name: "Shack bandmap" }), dest("p1", { type: "push", url_display: "" })];

beforeEach(() => {
  vi.mocked(getLocalClusterDestination).mockReset().mockResolvedValue({
    id: "l1", name: "Shack bandmap", enabled: false, url_display: "Long Lines Relay", settings: { relay_id: "r2", fields: ["comment", "reference"] },
  });
  vi.mocked(loadRelayTokens).mockReset().mockResolvedValue([OLD, SHACK, LAPTOP]);
  vi.mocked(previewLocalClusterLine).mockReset().mockResolvedValue(PREVIEW);
  vi.mocked(saveLocalClusterDestination).mockReset().mockResolvedValue("l9");
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
    <LocalClusterDestinationPage id={id} type={type} dests={dests} loading={loading} reload={reload} mobile={mobile} />,
    { route: "/destinations/x" },
  );
  return { ...r, reload };
}

const location = () => screen.getByTestId("location").textContent;
const nameField = () => screen.getByRole("textbox", { name: /Name/ });
const relaySelect = () => screen.getByRole("combobox", { name: "Relay" });
const commentList = () => screen.getByRole("group", { name: "Comment" });

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

  it("sends another type's id back to the list", () => {
    render({ id: "p1" });
    expect(location()).toBe("/destinations");
    expect(getLocalClusterDestination).not.toHaveBeenCalled();
  });

  it("needs type=local_cluster for a new destination", () => {
    render({ type: "push" });
    expect(location()).toBe("/destinations");
  });

  it("shows the load error, or a generic one", async () => {
    vi.mocked(getLocalClusterDestination).mockRejectedValueOnce(new Error("Destination not found."));
    render({ id: "l1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Destination not found.");
  });

  it("falls back to a generic load error", async () => {
    vi.mocked(getLocalClusterDestination).mockRejectedValueOnce({});
    render({ id: "l1" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the destination.");
  });
});

describe("new destination", () => {
  it("shows the page's copy, starts on the first relay that can receive spots and saves", async () => {
    const { user, app, reload } = render({ type: "local_cluster" });
    expect(screen.getByRole("heading", { name: "Add destination" })).toBeInTheDocument();
    expect(screen.getByText("New destination", { selector: "p" })).toBeInTheDocument(); // the breadcrumb
    expect(screen.getByRole("textbox", { name: "Type" })).toHaveValue("Local DX cluster");
    expect(screen.getByRole("textbox", { name: "Type" })).toHaveAttribute("readonly");
    expect(screen.getByText("Spots show up in your logging software's bandmap. Nothing tunes your radio until you pick a spot.")).toBeInTheDocument();
    expect(screen.getByText("Relay", { selector: ".MuiCardHeader-title" })).toBeInTheDocument();
    expect(screen.getByText("Which computer receives the spots")).toBeInTheDocument();
    expect(screen.getByText(
      "The relay runs a small DX cluster on that computer. Your logging software connects to it. The address and port are shown in the relay.",
    )).toBeInTheDocument();
    expect(screen.getByText("If the relay is offline, spots are dropped. Nothing is queued, because an old spot isn't useful in a bandmap."))
      .toBeInTheDocument();
    expect(screen.getByText(/Don't have the relay yet\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get the Long Lines Relay" })).toHaveAttribute("href", RELAY_DOWNLOAD_URL);
    expect(screen.getByText("Spot line")).toBeInTheDocument();
    expect(screen.getByText("Every spot is sent as a standard DX cluster line. Choose what goes in its comment and in what order."))
      .toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^Mode/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /^Mode/ })).toBeDisabled();
    expect(screen.getByText("Always included. Some logging software hides spots without a mode.")).toBeInTheDocument();
    expect(within(commentList()).getByText("Reference")).toBeInTheDocument();
    expect(within(commentList()).getByText("POTA park or SOTA summit, like K-0039")).toBeInTheDocument();
    expect(within(commentList()).getByRole("button", { name: "Add Source" })).toBeInTheDocument();
    expect(within(commentList()).getByRole("button", { name: "Add Spotter's comment" })).toBeInTheDocument();
    // No web Send test for this type.
    expect(screen.queryByRole("button", { name: /Send test/ })).not.toBeInTheDocument();

    // SHACK is the first relay with spots:read; the v1 relay is left out.
    await waitFor(() => expect(relaySelect()).toHaveTextContent("Shack PC · Windows"));
    expect(screen.getByText("Connected", { selector: ".MuiChip-label" })).toBeInTheDocument();
    await user.click(relaySelect());
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Shack PC · Windows", "Laptop · Windows"]);
    await user.click(screen.getByRole("option", { name: "Laptop · Windows" }));
    expect(screen.getByText("Offline", { selector: ".MuiChip-label" })).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save destination" });
    expect(save).toBeDisabled();
    await user.type(nameField(), " Shack bandmap ");
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(saveLocalClusterDestination).toHaveBeenCalledWith({
      name: "Shack bandmap", enabled: true, settings: { relay_id: "r2", fields: ["reference"] },
    });
    expect(reload).toHaveBeenCalled();
    expect(app.notify).toHaveBeenCalledWith("Added Shack bandmap");
  });

  it("previews SQL's line for the sample spot and follows the fields", async () => {
    const { user } = render({ type: "local_cluster" });
    expect(screen.getByText("Preview")).toBeInTheDocument();
    const card = screen.getByRole("heading", { name: "One spot, as your logging software sees it" }).closest<HTMLElement>(".MuiCard-root")!;
    expect(await screen.findByTestId("cluster-line")).toHaveTextContent(PREVIEW.line, { normalizeWhitespace: false });
    expect(previewLocalClusterLine).toHaveBeenLastCalledWith(["reference"], null);
    for (const [label, value] of [
      ["Spotter", "W4DOG"], ["Frequency", "14062.0 kHz"], ["Station", "K4ABC"], ["Comment", "CW POTA K-0039"], ["Time (UTC)", "21:14"],
    ]) {
      expect(within(card).getByText(label!).parentElement).toHaveTextContent(`${label}${value}`);
    }
    await user.click(within(commentList()).getByRole("button", { name: "Add Source" }));
    await waitFor(() => expect(previewLocalClusterLine).toHaveBeenLastCalledWith(["reference", "source"], null));
    await user.click(within(commentList()).getByRole("button", { name: "Remove Reference" }));
    await user.click(within(commentList()).getByRole("button", { name: "Remove Source" }));
    await waitFor(() => expect(previewLocalClusterLine).toHaveBeenLastCalledWith([], null));
  });

  it("shows a preview error", async () => {
    vi.mocked(previewLocalClusterLine).mockRejectedValue(new Error("Unknown field x."));
    render({ type: "local_cluster" });
    expect(await screen.findByText("Unknown field x.")).toBeInTheDocument();
  });

  it("falls back to a generic preview error", async () => {
    vi.mocked(previewLocalClusterLine).mockRejectedValue({});
    render({ type: "local_cluster" });
    expect(await screen.findByText("Couldn't load the preview.")).toBeInTheDocument();
  });

  it("keeps Save disabled without a relay that can receive spots", async () => {
    vi.mocked(loadRelayTokens).mockResolvedValue([OLD]);
    const { user } = render({ type: "local_cluster" });
    await user.type(nameField(), "Shack bandmap");
    await waitFor(() => expect(loadRelayTokens).toHaveBeenCalled());
    expect(relaySelect()).not.toHaveTextContent("Old PC");
    expect(screen.queryByText("Connected", { selector: ".MuiChip-label" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save destination" })).toBeDisabled();
  });

  it("shows a failed relay load in the card", async () => {
    vi.mocked(loadRelayTokens).mockRejectedValue(new Error("offline"));
    render({ type: "local_cluster" });
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save destination" })).toBeDisabled();
  });

  it("falls back to a generic relay load error", async () => {
    vi.mocked(loadRelayTokens).mockRejectedValue({});
    render({ type: "local_cluster" });
    expect(await screen.findByText("Couldn't load your relays.")).toBeInTheDocument();
  });

  it("shows a taken name on the field and stays", async () => {
    vi.mocked(saveLocalClusterDestination).mockRejectedValue(new Error("A destination named Shack already exists. Choose a different name."));
    const { user, app } = render({ type: "local_cluster" });
    await waitFor(() => expect(relaySelect()).toHaveTextContent("Shack PC"));
    await user.type(nameField(), "Shack");
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    expect(await screen.findByText("A destination named Shack already exists. Choose a different name.")).toBeInTheDocument();
    expect(nameField()).toBeInvalid();
    expect(location()).toBe("/destinations/x");
    expect(app.notify).not.toHaveBeenCalled();
    await user.type(nameField(), "2");
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
  });

  it("toasts any other save error and lets the user try again", async () => {
    vi.mocked(saveLocalClusterDestination).mockRejectedValue(new Error("Relay not found."));
    const { user, app } = render({ type: "local_cluster", mobile: true });
    await waitFor(() => expect(relaySelect()).toHaveTextContent("Shack PC"));
    await user.type(nameField(), "Shack");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Relay not found."));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("falls back to a generic save error", async () => {
    vi.mocked(saveLocalClusterDestination).mockRejectedValue({});
    const { user, app } = render({ type: "local_cluster" });
    await waitFor(() => expect(relaySelect()).toHaveTextContent("Shack PC"));
    await user.type(nameField(), "Shack");
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(app.notify).toHaveBeenCalledWith("Couldn't save the destination."));
  });

  it("cancels back to the list", async () => {
    const { user } = render({ type: "local_cluster" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(location()).toBe("/destinations");
    expect(saveLocalClusterDestination).not.toHaveBeenCalled();
  });
});

describe("editing", () => {
  it("loads the saved relay and fields, and saves changes", async () => {
    const { user, app } = render({ id: "l1" });
    expect(await screen.findByRole("heading", { name: "Edit destination" })).toBeInTheDocument();
    expect(getLocalClusterDestination).toHaveBeenCalledWith("l1");
    expect(screen.getByText("Shack bandmap", { selector: "p" })).toBeInTheDocument(); // the breadcrumb
    expect(nameField()).toHaveValue("Shack bandmap");
    expect(screen.getByRole("switch", { name: "Enabled" })).not.toBeChecked();
    // The saved relay stays chosen; a new destination's default never replaces it.
    await waitFor(() => expect(relaySelect()).toHaveTextContent("Laptop · Windows"));
    expect(within(commentList()).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Spotter's comment"), expect.stringContaining("Reference"),
    ]);
    await user.click(within(commentList()).getByRole("button", { name: "Move Reference up" }));
    await user.click(screen.getByRole("switch", { name: "Enabled" }));
    await user.click(screen.getByRole("button", { name: "Save destination" }));
    await waitFor(() => expect(location()).toBe("/destinations"));
    expect(saveLocalClusterDestination).toHaveBeenCalledWith({
      id: "l1", name: "Shack bandmap", enabled: true, settings: { relay_id: "r2", fields: ["reference", "comment"] },
    });
    expect(app.notify).toHaveBeenCalledWith("Saved changes");
  });

  it("keeps a saved relay that has no spots:read in the list", async () => {
    vi.mocked(getLocalClusterDestination).mockResolvedValueOnce({
      id: "l1", name: "Shack bandmap", enabled: true, url_display: "Long Lines Relay", settings: { relay_id: "r0", fields: [] },
    });
    render({ id: "l1" });
    await waitFor(() => expect(relaySelect()).toHaveTextContent("Old PC"));
    expect(screen.getByRole("button", { name: "Save destination" })).toBeEnabled();
  });

  it("needs a relay picked once the saved one is revoked", async () => {
    vi.mocked(getLocalClusterDestination).mockResolvedValueOnce({
      id: "l1", name: "Shack bandmap", enabled: true, url_display: "Long Lines Relay", settings: { relay_id: null, fields: ["reference"] },
    });
    render({ id: "l1" });
    expect(await screen.findByRole("heading", { name: "Edit destination" })).toBeInTheDocument();
    await waitFor(() => expect(loadRelayTokens).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Save destination" })).toBeDisabled();
  });
});
