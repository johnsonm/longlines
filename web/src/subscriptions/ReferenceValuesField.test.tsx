import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { useState } from "react";
import { renderPage } from "../test/render";
import { searchReferences } from "../lib/api";
import type { ReferenceProgram, ReferenceSearch, ReferenceSearchResult } from "../references/types";
import { newReferenceSearchCache, type ReferenceSearchCache } from "./model";
import { NOT_LISTED_TEXT, ReferenceValuesField, SEARCH_FAILED_TEXT, SEARCHING_TEXT } from "./ReferenceValuesField";

vi.mock("../lib/api", () => ({ searchReferences: vi.fn() }));

function result(program: ReferenceProgram, reference: string, name: string | null, active = true): ReferenceSearchResult {
  return {
    program, reference, name, active, validTo: null, location: null, association: null, region: null, country: null, grid: null,
    altitudeM: null, points: null, activations: 3, lastDay: "2026-10-20",
  };
}

const MITCHELL: ReferenceSearch = {
  results: [
    result("sota", "W4C/CM-001", "Mount Mitchell"),
    result("pota", "US-2763", "Mount Mitchell State Park"),
    result("wwff", "KFF-0000", "Old Mitchell", false),
  ],
  more: false,
};

/** A promise and the functions that settle it, so a test decides when a search answers. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const advance = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

interface Opts {
  values?: string[];
  program?: ReferenceProgram | null;
  cache?: ReferenceSearchCache;
}

function render({ values = [], program = null, cache = newReferenceSearchCache() }: Opts = {}) {
  const changes: string[][] = [];
  function Harness() {
    const [v, setV] = useState(values);
    return (
      <ReferenceValuesField
        values={v} onChange={(next) => { changes.push(next); setV(next); }} program={program} cache={cache} label="Values" error={false}
      />
    );
  }
  const r = renderPage(<Harness />);
  return { ...r, changes, cache, input: () => screen.getByRole("combobox", { name: "Values" }) };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(searchReferences).mockReset().mockResolvedValue(MITCHELL);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReferenceValuesField", () => {
  it("shows stored chips without searching", async () => {
    render({ values: ["US-2763", "W4C/CM-001"] });
    expect(screen.getByRole("button", { name: "US-2763" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "W4C/CM-001" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("US-2763 or Mount Mitchell")).toBeInTheDocument();
    await advance(1000);
    expect(searchReferences).not.toHaveBeenCalled();
  });

  it("searches nothing under two characters", async () => {
    const { user, input } = render();
    await user.type(input(), " m ");
    await advance(1000);
    expect(searchReferences).not.toHaveBeenCalled();
    expect(screen.queryByText(SEARCHING_TEXT)).not.toBeInTheDocument();
  });

  it("sends one search once typing settles, then lists the matches", async () => {
    const { user, input } = render();
    await user.type(input(), "mitch");
    expect(screen.getByText(SEARCHING_TEXT)).toBeInTheDocument();
    expect(searchReferences).not.toHaveBeenCalled();
    await advance(300);
    expect(searchReferences).toHaveBeenCalledTimes(1);
    expect(searchReferences).toHaveBeenCalledWith("mitch", null);
    expect(screen.getByText("Mount Mitchell")).toBeInTheDocument();
    expect(screen.getByText("Mount Mitchell State Park")).toBeInTheDocument();
    expect(screen.getByText("W4C/CM-001")).toBeInTheDocument();
    expect(screen.getByText("SOTA")).toBeInTheDocument();
    expect(screen.getByText("POTA")).toBeInTheDocument();
    expect(screen.getByText("WWFF")).toBeInTheDocument();
    // Only the WWFF row is retired.
    expect(screen.getAllByText("Retired")).toHaveLength(1);
    expect(screen.queryByText(SEARCHING_TEXT)).not.toBeInTheDocument();
  });

  it("collapses spaces and sends no search beyond six words or 64 characters", async () => {
    const { user, input } = render();
    await user.type(input(), "  mount   mitchell ");
    await advance(300);
    expect(searchReferences).toHaveBeenCalledWith("mount mitchell", null);
    vi.mocked(searchReferences).mockClear();
    // Pasted, so the field never holds a shorter search on the way.
    await user.clear(input());
    await user.paste("a b c d e f g");
    expect(input()).toHaveValue("a b c d e f g");
    await advance(300);
    await user.clear(input());
    await user.paste("x".repeat(65));
    expect(input()).toHaveValue("x".repeat(65));
    await advance(300);
    expect(searchReferences).not.toHaveBeenCalled();
  });

  it("answers a search it has seen from the cache, whatever the case", async () => {
    const cache = newReferenceSearchCache();
    const { user, input } = render({ cache });
    await user.type(input(), "mitch");
    await advance(300);
    await user.clear(input());
    await user.type(input(), "MITCH");
    expect(screen.getByText("Mount Mitchell")).toBeInTheDocument();
    await advance(1000);
    expect(searchReferences).toHaveBeenCalledTimes(1);
    expect(cache.results.size).toBe(1);
  });

  it("searches the program it is given", async () => {
    const { user, input } = render({ program: "sota" });
    await user.type(input(), "mitch");
    await advance(300);
    expect(searchReferences).toHaveBeenCalledWith("mitch", "sota");
  });

  it("never lets a late answer replace a newer search's", async () => {
    const first = deferred<ReferenceSearch>();
    const second = deferred<ReferenceSearch>();
    vi.mocked(searchReferences).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { user, input } = render();
    await user.type(input(), "mo");
    await advance(300);
    await user.type(input(), "unt");
    await advance(300);
    expect(searchReferences).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve({ results: [result("pota", "US-1000", "Mount Rogers")], more: false }));
    expect(screen.getByText("Mount Rogers")).toBeInTheDocument();
    await act(async () => first.resolve(MITCHELL));
    expect(screen.getByText("Mount Rogers")).toBeInTheDocument();
    expect(screen.queryByText("Mount Mitchell")).not.toBeInTheDocument();
  });

  it("does not send a search again while the same one is out", async () => {
    const first = deferred<ReferenceSearch>();
    vi.mocked(searchReferences).mockReturnValueOnce(first.promise);
    const { user, input } = render();
    await user.type(input(), "mo");
    await advance(300);
    await user.type(input(), "u");
    await user.type(input(), "{Backspace}");
    await advance(300);
    expect(searchReferences).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(MITCHELL));
    expect(screen.getByText("Mount Mitchell")).toBeInTheDocument();
  });

  it("adds the stored reference of a chosen option", async () => {
    const { user, input, changes } = render({ values: ["US-0001"] });
    await user.type(input(), "mitch");
    await advance(300);
    await user.click(screen.getByText("Mount Mitchell"));
    expect(changes.at(-1)).toEqual(["US-0001", "W4C/CM-001"]);
    expect(screen.getByRole("button", { name: "W4C/CM-001" })).toBeInTheDocument();
    // A chosen reference is not offered again.
    await user.type(input(), "mitch");
    expect(screen.queryByText("Mount Mitchell")).not.toBeInTheDocument();
    expect(screen.getByText("Mount Mitchell State Park")).toBeInTheDocument();
  });

  it("says when nothing in the lists matches, and Enter still adds the value", async () => {
    vi.mocked(searchReferences).mockResolvedValue({ results: [], more: false });
    const { user, input, changes } = render();
    await user.type(input(), "b/g-0001");
    await advance(300);
    expect(screen.getByText(NOT_LISTED_TEXT)).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(changes.at(-1)).toEqual(["B/G-0001"]);
  });

  it("adds an IOTA island typed before the search answers", async () => {
    const { user, input, changes } = render();
    await user.type(input(), "eu-005{Enter}");
    expect(changes.at(-1)).toEqual(["EU-005"]);
  });

  it("splits a typed list into one chip per reference", async () => {
    const { user, input, changes } = render();
    await user.type(input(), "us-1000, us-1001{Enter}");
    expect(changes.at(-1)).toEqual(["US-1000", "US-1001"]);
  });

  it("says when the search fails, keeps typing open and searches again later", async () => {
    vi.mocked(searchReferences).mockRejectedValueOnce(new Error("429"));
    const { user, input, changes } = render();
    await user.type(input(), "mitch");
    await advance(300);
    expect(screen.getByText(SEARCH_FAILED_TEXT)).toBeInTheDocument();
    await user.type(input(), "e");
    await advance(300);
    expect(searchReferences).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Mount Mitchell")).toBeInTheDocument();
    await user.clear(input());
    await user.type(input(), "us-2763{Enter}");
    expect(changes.at(-1)).toEqual(["US-2763"]);
  });

  it("retries a search that failed when it is typed again", async () => {
    vi.mocked(searchReferences).mockRejectedValueOnce(new Error("503"));
    const { user, input } = render();
    await user.type(input(), "mitch");
    await advance(300);
    expect(screen.getByText(SEARCH_FAILED_TEXT)).toBeInTheDocument();
    await user.type(input(), "{Backspace}");
    await user.type(input(), "h");
    await advance(300);
    expect(searchReferences).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Mount Mitchell")).toBeInTheDocument();
  });
});
