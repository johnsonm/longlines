import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearReturnPath, isSafeReturnPath, peekReturnPath, saveReturnPath } from "./returnPath";

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (k: string) => items.get(k) ?? null,
    key: (i: number) => [...items.keys()][i] ?? null,
    removeItem: (k: string) => void items.delete(k),
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isSafeReturnPath", () => {
  it.each([
    "/relay/approve?code=KQ7M-X4PD",
    "/connections/new?source=pota&reference=US-0001#top",
    "/home",
    "/",
  ])("accepts the same-origin path %s", (path) => {
    expect(isSafeReturnPath(path)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["empty", ""],
    ["protocol-relative", "//evil.example/x"],
    ["backslash protocol-relative", "/\\evil.example/x"],
    ["absolute URL", "https://evil.example/"],
    ["javascript: URL", "javascript:alert(1)"],
    ["relative path", "home"],
    ["a tab browsers strip into //", "/\t/evil.example"],
    ["a newline", "/home\n"],
    ["DEL", "/home\u007f"],
    ["too long", `/${"a".repeat(2048)}`],
  ])("refuses %s", (_name, path) => {
    expect(isSafeReturnPath(path)).toBe(false);
  });
});

describe("save, peek and clear", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
  });

  it("keeps a path until cleared, and peeking does not clear it", () => {
    saveReturnPath("/relay/approve?code=KQ7M-X4PD");
    expect(peekReturnPath()).toBe("/relay/approve?code=KQ7M-X4PD");
    expect(peekReturnPath()).toBe("/relay/approve?code=KQ7M-X4PD");
    clearReturnPath();
    expect(peekReturnPath()).toBeNull();
  });

  it("clears what was kept when the new path is missing or unsafe", () => {
    saveReturnPath("/home");
    saveReturnPath(undefined);
    expect(peekReturnPath()).toBeNull();
    saveReturnPath("/home");
    saveReturnPath("//evil.example");
    expect(peekReturnPath()).toBeNull();
  });

  it("never hands back an unsafe stored value", () => {
    storage.setItem("longlines.returnPath", "https://evil.example/");
    expect(peekReturnPath()).toBeNull();
  });

  it("does nothing, without throwing, where storage throws", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("sessionStorage", { ...storage, getItem: boom, setItem: boom, removeItem: boom });
    expect(() => saveReturnPath("/home")).not.toThrow();
    expect(() => saveReturnPath(undefined)).not.toThrow();
    expect(peekReturnPath()).toBeNull();
    expect(() => clearReturnPath()).not.toThrow();
  });

  it("does nothing where reading sessionStorage itself throws", () => {
    vi.unstubAllGlobals();
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(() => saveReturnPath("/home")).not.toThrow();
      expect(peekReturnPath()).toBeNull();
      expect(() => clearReturnPath()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, "sessionStorage", original);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});
