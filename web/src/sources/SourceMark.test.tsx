import { describe, expect, it } from "vitest";
import { renderPage } from "../test/render";
import { findLiveSource, SOURCES } from "./sources";
import { SourceMark } from "./SourceMark";

describe("SourceMark", () => {
  it("shows a program's logo", () => {
    const { container } = renderPage(<SourceMark source={findLiveSource("pota")!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/pota\.png$/));
  });

  it("shows the RBN logo", () => {
    const { container } = renderPage(<SourceMark source={findLiveSource("rbn")!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/rbn\.png$/));
  });

  it("falls back to the two-letter mark for a source without a logo", () => {
    const planned = SOURCES.find((s) => s.id === "pskreporter")!;
    const { container } = renderPage(<SourceMark source={planned} size="large" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("PS");
  });
});
