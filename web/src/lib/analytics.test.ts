import { describe, expect, it } from "vitest";
import { withoutQueryOrHash } from "./analytics";

describe("withoutQueryOrHash", () => {
  it("drops the query string and hash from the reported URL, keeping the rest of the event", () => {
    expect(withoutQueryOrHash({ type: "pageview", url: "https://longlines.io/set-password#access_token=a&refresh_token=r" }))
      .toEqual({ type: "pageview", url: "https://longlines.io/set-password" });
    expect(withoutQueryOrHash({ type: "vital", url: "https://longlines.io/reset-password?code=x#y", route: "/reset-password" }))
      .toEqual({ type: "vital", url: "https://longlines.io/reset-password", route: "/reset-password" });
    const plain = { type: "pageview", url: "https://longlines.io/stats" };
    expect(withoutQueryOrHash(plain)).toBe(plain);
  });
});
