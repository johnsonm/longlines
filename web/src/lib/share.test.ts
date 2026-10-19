import { afterEach, describe, expect, it, vi } from "vitest";
import { shareLink } from "./share";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNavigator(share: unknown, writeText: (url: string) => Promise<void>) {
  vi.stubGlobal("navigator", { share, clipboard: { writeText } });
}

describe("shareLink", () => {
  const args = (notify = vi.fn()) => ({ title: "T", url: "https://x/g/a", copied: "Link copied", notify });

  it("uses the share sheet when there is one", async () => {
    const share = vi.fn(() => Promise.resolve());
    const writeText = vi.fn(() => Promise.resolve());
    stubNavigator(share, writeText);
    const a = args();
    await shareLink(a);
    expect(share).toHaveBeenCalledWith({ title: "T", url: "https://x/g/a" });
    expect(writeText).not.toHaveBeenCalled();
    expect(a.notify).not.toHaveBeenCalled();
  });

  it("does nothing more when the sheet is closed", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubNavigator(() => Promise.reject(new DOMException("closed", "AbortError")), writeText);
    await shareLink(args());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the link when the sheet is refused or missing", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubNavigator(() => Promise.reject(new DOMException("no", "NotAllowedError")), writeText);
    const a = args();
    await shareLink(a);
    expect(writeText).toHaveBeenCalledWith("https://x/g/a");
    expect(a.notify).toHaveBeenCalledWith("Link copied");
    stubNavigator(undefined, writeText);
    await shareLink(a);
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("says when the link can't be copied", async () => {
    stubNavigator(undefined, () => Promise.reject(new Error("denied")));
    const a = args();
    await shareLink(a);
    expect(a.notify).toHaveBeenCalledWith("Couldn't copy the link.");
  });
});
