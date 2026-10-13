import { describe, expect, it, vi } from "vitest";
import { cached, keyedCached } from "./cache";

const keepFor = (ms: number) => (value: string | null) => (value === null ? null : Date.now() + ms);

describe("cached", () => {
  it("shares one in-flight load and keeps a fresh value without reloading", async () => {
    const load = vi.fn(async () => "snap");
    const get = cached(load, keepFor(60_000));
    expect(get.peek()).toBeUndefined();
    const [a, b] = await Promise.all([get.get(), get.get()]);
    expect(a).toBe(b);
    await get.get();
    expect(get.peek()).toBe("snap");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once the value has expired", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
      const get = cached(load, keepFor(1_000));
      await expect(get.get()).resolves.toBe("old");
      vi.advanceTimersByTime(999);
      await expect(get.get()).resolves.toBe("old");
      vi.advanceTimersByTime(1);
      expect(get.peek()).toBeUndefined();
      await expect(get.get()).resolves.toBe("new");
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep a value that freshUntil rejects, so the next call loads again", async () => {
    const load = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce("snap");
    const get = cached(load, keepFor(60_000));
    await expect(get.get()).resolves.toBeNull();
    expect(get.peek()).toBeUndefined();
    await expect(get.get()).resolves.toBe("snap");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries after a failure instead of caching the rejection", async () => {
    const load = vi.fn<() => Promise<string | null>>().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce("ok");
    const get = cached(load, keepFor(60_000));
    await expect(get.get()).rejects.toThrow("down");
    await expect(get.get()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("keyedCached", () => {
  it("loads and keeps each key on its own", async () => {
    const load = vi.fn(async (key: string) => `profile ${key}`);
    const profiles = keyedCached(load, keepFor(60_000));
    expect(profiles.peek("KK4PWJ")).toBeUndefined();
    await expect(profiles.get("KK4PWJ")).resolves.toBe("profile KK4PWJ");
    await expect(profiles.get("W1AW")).resolves.toBe("profile W1AW");
    await profiles.get("KK4PWJ");
    expect(profiles.peek("KK4PWJ")).toBe("profile KK4PWJ");
    expect(load.mock.calls).toEqual([["KK4PWJ"], ["W1AW"]]);
  });

  it("reloads a key once it has expired, without touching the others", async () => {
    let clock = 0;
    const load = vi.fn(async (key: string) => `${key}@${clock}`);
    const profiles = keyedCached(load, () => clock + 1_000, () => clock);
    await profiles.get("A");
    clock = 500;
    await profiles.get("B");
    clock = 1_000;
    expect(profiles.peek("A")).toBeUndefined();
    expect(profiles.peek("B")).toBe("B@500");
    await expect(profiles.get("A")).resolves.toBe("A@1000");
  });
});

describe("put", () => {
  it("keeps a value obtained elsewhere so get does not load it", async () => {
    const load = vi.fn(async (key: string) => key);
    const profiles = keyedCached(load, keepFor(60_000));
    profiles.put("KK4PWJ", "from KK4PWJ/P");
    expect(profiles.peek("KK4PWJ")).toBe("from KK4PWJ/P");
    await expect(profiles.get("KK4PWJ")).resolves.toBe("from KK4PWJ/P");
    expect(load).not.toHaveBeenCalled();
  });

  it("drops a value that freshUntil rejects", () => {
    const get = cached(vi.fn(async () => "snap"), keepFor(60_000));
    get.put(null as unknown as string);
    expect(get.peek()).toBeUndefined();
  });
});
