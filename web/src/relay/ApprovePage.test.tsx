import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderPage } from "../test/render";
import { answerRelayPairing, lookupRelayPairing } from "../lib/api";
import { ApprovePage } from "./ApprovePage";
import { LOGGERS_URL, SPOTS_READ_LINE } from "./model";

vi.mock("../lib/api", () => ({
  lookupRelayPairing: vi.fn(),
  answerRelayPairing: vi.fn(),
}));

const PENDING = {
  status: "pending" as const, code: "KQ7M-X4PD", device_name: "SHACK-PC", scopes: ["contacts:write"],
  expires_at: "2026-10-28T21:30:00Z",
};

beforeEach(() => {
  vi.mocked(lookupRelayPairing).mockReset().mockResolvedValue(PENDING);
  vi.mocked(answerRelayPairing).mockReset().mockResolvedValue({ status: "approved" });
});

const render = (search = "?code=kq7mx4pd") => renderPage(<ApprovePage />, { route: "/relay/approve", search });

describe("ApprovePage", () => {
  it("shows the relay's code, what it may do and who will see its spots", async () => {
    render();
    expect(await screen.findByText("KQ7M-X4PD")).toBeInTheDocument();
    expect(lookupRelayPairing).toHaveBeenCalledWith("kq7mx4pd");
    expect(lookupRelayPairing).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: "Connect Long Lines Relay" })).toBeInTheDocument();
    expect(screen.getByText("A computer is asking to post the contacts you log to Long Lines as spots.")).toBeInTheDocument();
    expect(screen.getByText("Make sure this matches the code in the relay.")).toBeInTheDocument();
    expect(screen.getByText("KK4PWJ").closest("p")).toHaveTextContent("Post contacts logged as KK4PWJ as spots");
    expect(screen.getByText("Can't read or change your connections, groups, destinations or settings")).toBeInTheDocument();
    expect(screen.getByText("Spots from your log are visible to other Long Lines users, like spots from any other source.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "API tokens" })).toHaveAttribute("href", "/api-tokens");
    // The address now carries the code as SQL normalized it.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveAttribute("data-search", "?code=KQ7M-X4PD"));
  });

  it("says a v1 relay only posts contacts", async () => {
    render();
    expect(await screen.findByText("KQ7M-X4PD")).toBeInTheDocument();
    expect(screen.queryByText(SPOTS_READ_LINE)).not.toBeInTheDocument();
  });

  it("adds the spots line when the relay asks for spots:read, and keeps it after a refused answer", async () => {
    vi.mocked(lookupRelayPairing).mockResolvedValue({ ...PENDING, scopes: ["contacts:write", "spots:read"] });
    vi.mocked(answerRelayPairing).mockRejectedValueOnce(new Error("Couldn't answer the relay."));
    const { user } = render();
    expect(await screen.findByText(SPOTS_READ_LINE)).toBeInTheDocument();
    expect(screen.getByText("KK4PWJ").closest("p")).toHaveTextContent("Post contacts logged as KK4PWJ as spots");
    expect(SPOTS_READ_LINE).toBe("Receive the spots that match your connections, for its local DX cluster");
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Couldn't answer the relay.")).toBeInTheDocument();
    expect(screen.getByText(SPOTS_READ_LINE)).toBeInTheDocument();
  });

  it("leaves out the contacts line for a relay that only reads spots", async () => {
    vi.mocked(lookupRelayPairing).mockResolvedValue({ ...PENDING, scopes: ["spots:read"] });
    render();
    expect(await screen.findByText(SPOTS_READ_LINE)).toBeInTheDocument();
    expect(screen.queryByText(/Post contacts logged as/)).not.toBeInTheDocument();
  });

  it("connects the relay on Allow", async () => {
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Allow" }));
    expect(answerRelayPairing).toHaveBeenCalledWith("KQ7M-X4PD", true);
    expect(await screen.findByRole("heading", { name: "Relay connected" })).toBeInTheDocument();
    expect(screen.getByText("This computer can now post your logged contacts as spots. You can close this tab and go back to the relay.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up logging software" })).toHaveAttribute("href", LOGGERS_URL);
  });

  it("refuses the relay on Deny", async () => {
    vi.mocked(answerRelayPairing).mockResolvedValueOnce({ status: "denied" });
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    expect(answerRelayPairing).toHaveBeenCalledWith("KQ7M-X4PD", false);
    expect(await screen.findByRole("heading", { name: "Relay not connected" })).toBeInTheDocument();
    expect(screen.getByText("Denied by mistake? Select Sign in with Long Lines in the relay to get a new code.")).toBeInTheDocument();
  });

  it("keeps the request open and says why when Allow is refused", async () => {
    vi.mocked(answerRelayPairing).mockRejectedValueOnce(new Error("You can connect up to 10 relays. Disconnect one in API tokens first."));
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("You can connect up to 10 relays. Disconnect one in API tokens first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("says the code expired when it ran out while the page was open", async () => {
    vi.mocked(answerRelayPairing).mockResolvedValueOnce({ status: "expired" });
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("This code expired")).toBeInTheDocument();
  });

  it("asks for the code again when it vanished while the page was open", async () => {
    vi.mocked(answerRelayPairing).mockResolvedValueOnce({ status: "unknown" });
    const { user } = render();
    await user.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("We don't recognize this code. Check it against the relay and try again.")).toBeInTheDocument();
  });

  it("shows an expired code struck through, with no way to allow it", async () => {
    vi.mocked(lookupRelayPairing).mockResolvedValueOnce({ status: "expired", code: "KQ7M-X4PD" });
    render();
    expect(await screen.findByText("This code expired")).toBeInTheDocument();
    expect(screen.getByText("Codes last 10 minutes. In the relay, select Sign in with Long Lines to get a new one.")).toBeInTheDocument();
    expect(screen.getByText("KQ7M-X4PD").closest("s")).not.toBeNull();
    expect(screen.getByText("A computer asked to post the contacts you log to Long Lines as spots.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("asks for the code when it opens without one, and checks what is typed", async () => {
    const { user } = render("");
    expect(screen.getByText("Enter the code shown in the relay on your computer.")).toBeInTheDocument();
    expect(screen.getByText("Codes look like KQ7M-X4PD and last 10 minutes. If the relay shows a different code now, use that one.")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Continue" });
    expect(go).toBeDisabled();
    expect(lookupRelayPairing).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Code"), "kq7m-x4pd");
    await user.click(go);
    expect(lookupRelayPairing).toHaveBeenCalledWith("kq7m-x4pd");
    expect(await screen.findByRole("button", { name: "Allow" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveAttribute("data-search", "?code=KQ7M-X4PD"));
  });

  it("marks a code it doesn't recognize and keeps it to correct", async () => {
    vi.mocked(lookupRelayPairing).mockResolvedValueOnce({ status: "unknown", code: "KQ7M-X4BD" });
    const { user } = render("?code=KQ7M-X4BD");
    expect(await screen.findByText("We don't recognize this code. Check it against the relay and try again.")).toBeInTheDocument();
    const field = screen.getByLabelText("Code");
    expect(field).toHaveValue("KQ7M-X4BD");
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.clear(field);
    await user.type(field, "KQ7M-X4PD{Enter}");
    await waitFor(() => expect(lookupRelayPairing).toHaveBeenLastCalledWith("KQ7M-X4PD"));
    expect(await screen.findByRole("button", { name: "Allow" })).toBeInTheDocument();
  });

  it("keeps a malformed code in the address bar as it was", async () => {
    vi.mocked(lookupRelayPairing).mockResolvedValueOnce({ status: "unknown", code: null });
    render("?code=hello");
    expect(await screen.findByLabelText("Code")).toHaveValue("hello");
    expect(screen.getByTestId("location")).toHaveAttribute("data-search", "?code=hello");
  });

  it("says when the code cannot be checked", async () => {
    vi.mocked(lookupRelayPairing).mockRejectedValueOnce(new Error("Couldn't reach Long Lines."));
    render();
    expect(await screen.findByText("Couldn't reach Long Lines.")).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveValue("kq7mx4pd");
    expect(screen.getByLabelText("Code")).not.toHaveAttribute("aria-invalid", "true");
  });
});
