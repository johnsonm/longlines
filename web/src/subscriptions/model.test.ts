import { describe, expect, it } from "vitest";
import type { SubscriptionWithLinks } from "../lib/api";
import { blankSub, filterChips, toInput } from "./model";

const GROUPS = [{ id: "g1", name: "Friends" }, { id: "g2", name: "RARS members" }, { id: "g3", name: "Unused" }];

describe("blankSub and toInput", () => {
  it("starts a new subscription with no groups", () => {
    expect(blankSub().group_ids).toEqual([]);
  });

  it("carries a subscription's groups into the dialog", () => {
    const row = { id: "s1", name: "Club", group_ids: ["g2"], callsigns: [] } as unknown as SubscriptionWithLinks;
    expect(toInput(row).group_ids).toEqual(["g2"]);
  });
});

describe("filterChips", () => {
  it("adds a Group chip per group after the callsigns, in the groups list's order", () => {
    const sub = { ...blankSub(), callsigns: ["W1AW"], reference: "US-NC", group_ids: ["g2", "g1"] };
    expect(filterChips(sub, GROUPS)).toEqual(["All sources", "W1AW", "Group: Friends", "Group: RARS members", "Ref contains US-NC", "Once per 10 min"]);
  });

  it("leaves the group chips out when the groups list didn't load", () => {
    expect(filterChips({ ...blankSub(), group_ids: ["g1"] }, null)).toEqual(["All sources", "Once per 10 min"]);
  });
});
