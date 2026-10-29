import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { WebhookEndpointCard, type WebhookEndpointCardProps } from "./WebhookEndpointCard";
import type { HeaderRow } from "./webhookModel";

vi.mock("../lib/api", () => ({}));

const MASKED = "https://logger.example.org/hook/••••••";

/** Holds the URL and header rows like the page does, so typing reaches the fields. */
function Harness(props: Partial<WebhookEndpointCardProps> & { initialUrl?: string | null; initialHeaders?: HeaderRow[]; spy?: (rows: HeaderRow[]) => void }) {
  const { initialUrl = "", initialHeaders = [], spy, ...rest } = props;
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [headers, setHeaders] = useState<HeaderRow[]>(initialHeaders);
  return (
    <>
      <span data-testid="url">{url === null ? "closed" : url}</span>
      <WebhookEndpointCard
        urlDisplay={null} url={url} onUrlChange={setUrl} rotatedAt={null} rotating={false}
        headers={headers} urlReplaced={false}
        onHeadersChange={(rows) => {
          spy?.(rows);
          setHeaders(rows);
        }}
        {...rest}
      />
    </>
  );
}

const saved = (name: string): HeaderRow => ({ key: `k-${name}`, name, value: "", saved: name });

describe("URL", () => {
  it("asks a new destination for an https URL", async () => {
    const { user } = renderPage(<Harness />);
    expect(screen.getByText("Endpoint")).toBeInTheDocument();
    expect(screen.getByText("Requests are sent as POST with a JSON body.")).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Webhook URL" });
    expect(screen.getByText("Must start with https://")).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-invalid", "false");
    await user.type(field, "http://x");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("url")).toHaveTextContent("http://x");
    expect(screen.queryByRole("button", { name: "Keep current URL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace URL" })).not.toBeInTheDocument();
  });

  it("shows a saved URL masked, then Replace URL opens an empty field and Keep current URL closes it", async () => {
    const { user } = renderPage(<Harness urlDisplay={MASKED} initialUrl={null} onRotate={() => {}} />);
    expect(screen.getByText(MASKED)).toBeInTheDocument();
    expect(screen.getByText("The URL is hidden after saving.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Webhook URL" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace URL" }));
    const field = screen.getByRole("textbox", { name: "Webhook URL" });
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    expect(screen.getByTestId("url")).toHaveTextContent("");
    await user.type(field, "https://new.example.org/x");
    await user.click(screen.getByRole("button", { name: "Keep current URL" }));
    expect(screen.getByTestId("url")).toHaveTextContent("closed");
    expect(screen.getByText(MASKED)).toBeInTheDocument();
  });
});

describe("signing secret", () => {
  const help = "We sign each request with this secret so you can check it came from Long Lines. It is only shown once, when created or rotated.";

  it("says a new destination gets one on Add", () => {
    renderPage(<Harness />);
    expect(screen.getByText("Signing secret")).toBeInTheDocument();
    expect(screen.getByText("A signing secret is created when you add the destination.")).toBeInTheDocument();
    expect(screen.getByText(help)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("masked-secret")).not.toBeInTheDocument();
  });

  it("shows the mask, Rotate and when it was rotated", async () => {
    const onRotate = vi.fn();
    const rotatedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    const { user } = renderPage(<Harness urlDisplay={MASKED} initialUrl={null} onRotate={onRotate} rotatedAt={rotatedAt} />);
    expect(screen.getByTestId("masked-secret")).toHaveTextContent("whsec_••••••••");
    expect(screen.getByText(`${help} Rotated 3 hours ago.`)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    expect(onRotate).toHaveBeenCalledTimes(1);
  });

  it("disables Rotate while rotating and leaves out the age when never rotated", () => {
    renderPage(<Harness urlDisplay={MASKED} initialUrl={null} onRotate={() => {}} rotating />);
    expect(screen.getByRole("button", { name: "Rotate" })).toBeDisabled();
    expect(screen.getByText(help)).toBeInTheDocument();
  });
});

describe("extra headers", () => {
  it("adds, fills and removes rows", async () => {
    const { user } = renderPage(<Harness />);
    expect(screen.getByText("Extra headers")).toBeInTheDocument();
    expect(screen.getByText("Sent with every request, for example an API key. Stored encrypted and never shown again after saving.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Header" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add a header" }));
    await user.type(screen.getByRole("textbox", { name: "Header" }), "Authorization");
    // A new header needs a value.
    expect(screen.getByText("Give the Authorization header a value.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Value" }), "Bearer abc");
    expect(screen.queryByText("Give the Authorization header a value.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue("Bearer abc");

    await user.click(screen.getByRole("button", { name: "Remove header" }));
    expect(screen.queryByRole("textbox", { name: "Header" })).not.toBeInTheDocument();
  });

  it("shows a saved value masked, keeps it unless typed, and wants one when renamed", async () => {
    const { user } = renderPage(<Harness urlDisplay={MASKED} initialUrl={null} onRotate={() => {}} initialHeaders={[saved("X-Key")]} />);
    const value = screen.getByRole("textbox", { name: "Value" });
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("placeholder", "••••••••••••");
    expect(screen.queryByText(/header a value/)).not.toBeInTheDocument();

    const name = screen.getByRole("textbox", { name: "Header" });
    await user.clear(name);
    expect(screen.getByText("Give each header a name.")).toBeInTheDocument();
    await user.type(name, "x-key");
    expect(screen.queryByText(/header a value/)).not.toBeInTheDocument(); // a case-only rename keeps the value
    await user.type(name, "2");
    expect(screen.getByText("Give the x-key2 header a value.")).toBeInTheDocument();
  });

  it("wants every saved value again while a new URL is typed", () => {
    renderPage(<Harness urlDisplay={MASKED} initialUrl="https://new.example.org/hook" onRotate={() => {}} initialHeaders={[saved("X-Key")]} urlReplaced />);
    const value = screen.getByRole("textbox", { name: "Value" });
    expect(value).not.toHaveAttribute("placeholder");
    expect(screen.getByText("Give the X-Key header a value.")).toBeInTheDocument();
    expect(screen.getByText("A new URL clears the saved header values, so enter them again.")).toBeInTheDocument();
  });

  it("stops at ten headers", async () => {
    const rows = Array.from({ length: 9 }, (_, i) => saved(`X-H${i}`));
    const spy = vi.fn();
    const { user } = renderPage(<Harness initialHeaders={rows} spy={spy} />);
    const add = screen.getByRole("button", { name: "Add a header" });
    await user.click(add);
    expect(screen.getAllByRole("textbox", { name: "Header" })).toHaveLength(10);
    expect(add).toBeDisabled();
  });
});
