import { describe, expect, it } from "vitest";
import { renderPage } from "../test/render";
import { findLiveSource, type SourceInfo } from "./sources";
import { SourceMark } from "./SourceMark";

/** A made-up planned source: the catalog has none right now, but the planned paths stay. */
const planned: SourceInfo = { ...findLiveSource("rbn")!, id: "future", title: "Future source", mark: "FS", status: "planned", statsKey: null };

describe("SourceMark", () => {
  it("shows a program's logo", () => {
    const { container } = renderPage(<SourceMark source={findLiveSource("pota")!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/pota\.png$/));
  });

  it("shows the RBN logo", () => {
    const { container } = renderPage(<SourceMark source={findLiveSource("rbn")!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/rbn\.png$/));
  });

  it("shows the WWBOTA logo", () => {
    const { container } = renderPage(<SourceMark source={findLiveSource("wwbota")!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/wwbota\.png$/));
    expect(container).not.toHaveTextContent("WB");
  });

  it("shows the IOTA logo", () => {
    const { container } = renderPage(<SourceMark source={findLiveSource("iota")!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/iota\.png$/));
    expect(container).not.toHaveTextContent("IO");
  });

  it("shows the Long Lines Relay mark for logged contacts", () => {
    const { container } = renderPage(<SourceMark source={findLiveSource("logged")!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringMatching(/logged\.png$/));
    expect(container).not.toHaveTextContent("LC");
  });

  it("falls back to the two-letter mark for a source without a logo", () => {
    const { container } = renderPage(<SourceMark source={planned} size="large" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("FS");
  });
});
