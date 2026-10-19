import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { SigningSecretDialog, type SigningSecretDialogProps } from "./SigningSecretDialog";

vi.mock("../lib/api", () => ({}));

const SECRET = "whsec_0123456789abcdef";

function render(props: Partial<SigningSecretDialogProps> = {}) {
  const onDone = vi.fn();
  const r = renderPage(<SigningSecretDialog variant="created" name="Logger" batchSeconds={0} secret={SECRET} onDone={onDone} {...props} />);
  return { ...r, onDone };
}

describe("SigningSecretDialog", () => {
  it("shows the created variant with the secret and the warning", () => {
    render();
    expect(screen.getByRole("dialog", { name: "Destination added" })).toBeInTheDocument();
    expect(screen.getByText("Logger will receive a request for each matching spot, with the fields you chose.")).toBeInTheDocument();
    expect(screen.getByText("Copy your signing secret now")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "It is shown once. We use it to sign each request so you can check it came from Long Lines. If you lose it, rotate it from this destination.",
    );
    expect(screen.getByTestId("signing-secret")).toHaveTextContent(SECRET);
  });

  it("words the created variant for a grouped destination", () => {
    render({ batchSeconds: 30 });
    expect(screen.getByText("Logger will receive a request every 30 seconds with the matching spots, with the fields you chose.")).toBeInTheDocument();
  });

  it("shows the rotated variant", () => {
    render({ variant: "rotated" });
    expect(screen.getByRole("dialog", { name: "Signing secret rotated" })).toBeInTheDocument();
    expect(screen.getByText("Logger signs requests with this new secret from now on. The old one no longer works.")).toBeInTheDocument();
  });

  it("is closed without a secret", () => {
    render({ secret: null });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("copies the secret and says so", async () => {
    const { user } = render();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("keeps Copy when the clipboard refuses", async () => {
    const { user } = render();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("enables Done only once the secret is saved, and closes only through Done", async () => {
    const { user, onDone } = render();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "I have saved the secret" }));
    expect(done).toBeEnabled();
    await user.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
