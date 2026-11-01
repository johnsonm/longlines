import { describe, expect, it } from "vitest";
import { activationPath, activationsTabPath, activationUrl } from "./paths";

describe("activation paths", () => {
  it("builds the canonical page and its shareable link", () => {
    expect(activationPath("kjw2khkyj47f")).toBe("/activations/kjw2khkyj47f");
    expect(activationUrl("https://longlines.io", "kjw2khkyj47f")).toBe("https://longlines.io/activations/kjw2khkyj47f");
  });

  it("encodes an id that is not one, so it stays one segment", () => {
    expect(activationPath("a/b")).toBe("/activations/a%2Fb");
  });

  it("links the callsign profile's tab by the base call", () => {
    expect(activationsTabPath("KK4PWJ")).toBe("/call/KK4PWJ?tab=activations");
    expect(activationsTabPath("VP2E/KK4PWJ")).toBe("/call/VP2E/KK4PWJ?tab=activations");
    expect(activationsTabPath("")).toBe("/lookup");
  });
});
