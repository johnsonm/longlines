import { describe, expect, it } from "vitest";
import { NOW, bands, card, parks, states } from "../test/goals";
import {
  atLeastNote, bandLabel, blockedDeleteText, browserStorage, cardMeta, chipLabel, completeRuleBanner, completeText, connectionDetail,
  contactTime, copyYear, datesLine, dismissKey, dismissRelay, endedBanner, entryName, evidenceLine, joinNames, neededParks, percent,
  relayBannerText, relayDismissed, relayLine, requirementsLine, reviewBanner, reviewDetail, reviewTitle, ruleLabel, showRelayBanner,
  usageLine, usedByNote, utcDay, windowLabel, workedLine,
} from "./model";

describe("dates", () => {
  it("words a window as the canvas does", () => {
    expect(windowLabel("2026-01-01", "2026-12-31")).toBe("Jan 1 – Dec 31, 2026");
    expect(windowLabel("2026-01-24", "2026-01-25")).toBe("Jan 24 – 25, 2026");
    expect(windowLabel("2025-12-01", "2026-01-31")).toBe("Dec 1, 2025 – Jan 31, 2026");
    expect(windowLabel("2026-06-27", "2026-06-27")).toBe("Jun 27, 2026");
    expect(windowLabel(null, null)).toBe("No end date");
    expect(utcDay(new Date("2026-10-29T23:59:00-05:00"))).toBe("2026-10-30");
  });

  it("counts the days left, the end day included", () => {
    expect(datesLine(card(), NOW, false)).toBe("Counts contacts from Jan 1 – Dec 31, 2026 · 64 days left");
    expect(datesLine(card(), NOW, true)).toBe("Jan 1 – Dec 31, 2026 · 64 days left");
    expect(datesLine(card({ ends_on: "2026-10-29" }), NOW, false)).toBe("Counts contacts from Jan 1 – Oct 29, 2026 · 1 day left");
    expect(datesLine(card({ starts_on: null, ends_on: null }), NOW, false)).toBe("No end date");
  });

  it("says when a list finished, and how early", () => {
    const done = card({ status: "complete", completed_at: "2026-11-18T10:00:00Z" });
    expect(datesLine(done, new Date("2026-11-20T00:00:00Z"), false)).toBe("Counts contacts from Jan 1 – Dec 31, 2026 · Finished Nov 18, 43 days early");
    expect(datesLine({ ...done, completed_at: "2026-12-31T22:00:00Z" }, new Date("2027-01-02T00:00:00Z"), false))
      .toBe("Counts contacts from Jan 1 – Dec 31, 2026 · Finished Dec 31, 2026");
    expect(datesLine({ ...done, starts_on: null, ends_on: null }, new Date("2026-11-20T00:00:00Z"), false)).toBe("No end date · Finished Nov 18");
  });

  it("says how long ago a list ended", () => {
    const ended = card({ status: "ended" });
    expect(datesLine(ended, new Date("2027-01-03T08:00:00Z"), false)).toBe("Counted contacts from Jan 1 – Dec 31, 2026 · Ended 3 days ago");
    expect(datesLine(ended, new Date("2027-01-01T08:00:00Z"), true)).toBe("Jan 1 – Dec 31, 2026 · Ended 1 day ago");
  });

  it("formats contact times in UTC, with the year only when it isn't this year's", () => {
    expect(contactTime("2026-10-03T21:14:00Z", NOW)).toBe("Oct 3, 21:14 UTC");
    expect(contactTime("2025-10-03T21:14:00Z", NOW)).toBe("Oct 3, 2025, 21:14 UTC");
  });
});

describe("cards", () => {
  it("words the meta and usage lines", () => {
    expect(cardMeta(card())).toBe("3 requirements · Jan 1 – Dec 31, 2026");
    expect(cardMeta(card({ requirement_count: 1, starts_on: null, ends_on: null }))).toBe("1 requirement · No end date");
    expect(usageLine(card())).toBe("Used by 2 connections");
    expect(usageLine(card({ connection_count: 1 }))).toBe("Used by 1 connection");
    expect(usageLine(card({ connection_count: 0 }))).toBe("Not used by any connection");
    expect(usageLine(card({ status: "complete", connection_count: 1 }))).toBe("Rule off on 1 connection");
    expect(usageLine(card({ status: "ended", connection_count: 0 }))).toBe("Not used by any connection");
    expect(workedLine(18, 64)).toBe("18 of 64 worked");
    expect(percent(18, 64)).toBe(28);
    expect(percent(0, 0)).toBe(0);
  });
});

describe("entries", () => {
  it("labels bands, chips and worked rows", () => {
    expect(bandLabel("80m")).toBe("80 m");
    expect(bandLabel("70cm")).toBe("70 cm");
    expect(bandLabel("1.25m")).toBe("1.25 m");
    expect(bandLabel("3cm_qo100")).toBe("QO-100");
    expect(bandLabel("weird")).toBe("weird");
    expect(chipLabel("state", { value: "AK", label: null })).toBe("AK");
    expect(entryName("state", { value: "AK", label: null })).toBe("Alaska");
    expect(chipLabel("park", { value: "US-2763", label: "Hanging Rock State Park" })).toBe("Hanging Rock State Park");
    expect(chipLabel("park", { value: "K-9999", label: null })).toBe("K-9999");
    expect(entryName("band", { value: "20m", label: null })).toBe("20 m");
  });

  it("words the rule", () => {
    expect(ruleLabel(states(), false)).toBe("Work all 50");
    expect(ruleLabel(bands(), false)).toBe("Work at least 4 of 6");
    expect(ruleLabel(bands(), true)).toBe("At least 4 of 6");
    expect(atLeastNote(bands())).toBe("Once you've worked 4, the other bands stop alerting too.");
    expect(atLeastNote({ kind: "park", at_least: null })).toBe("Once you've worked 0, the other parks stop alerting too.");
  });

  it("says how each entry got marked", () => {
    const [smoky] = parks().entries;
    expect(evidenceLine(smoky!, NOW, false)).toBe("Worked K4ABC · Oct 3, 21:14 UTC · Logged in N1MM, matched to a POTA spot at 21:09");
    expect(evidenceLine(smoky!, NOW, true)).toBe("K4ABC · Oct 3, 21:14 UTC · Matched to a POTA spot at 21:09");
    const contact = { worked_at: "2026-10-03T21:14:00Z", worked_how: "contact" as const };
    const evidence = { worked_call: "K4ABC", contact_time: "2026-10-03T21:14:00Z", logger_app: "N1MM", matched_spot_time: null };
    expect(evidenceLine({ ...contact, evidence }, NOW, false)).toBe("Worked K4ABC · Oct 3, 21:14 UTC · Logged in N1MM");
    expect(evidenceLine({ ...contact, evidence: { ...evidence, logger_app: null } }, NOW, false)).toBe("Worked K4ABC · Oct 3, 21:14 UTC");
    expect(evidenceLine({ worked_at: "2026-10-20T15:00:00Z", worked_how: "hand", evidence: null }, NOW, false)).toBe("Marked by hand · Oct 20");
    expect(evidenceLine({ worked_at: null, worked_how: "hand", evidence: null }, NOW, false)).toBe("Marked by hand");
  });

  it("finds the parks still needed in incomplete park requirements, once each", () => {
    const p = parks();
    expect(neededParks([p, { ...p, id: "r2" }, states()]).map((x) => x.reference))
      .toEqual(["US-2763", "US-2764", "US-2765", "US-2766", "US-0004", "US-0005", "US-0006"]);
    expect(neededParks([{ ...p, complete: true }])).toEqual([]);
  });
});

describe("needs a look", () => {
  it("words each contact and the banner", () => {
    expect(reviewTitle({ worked_call: "AA1ZZ", band: "20m", mode: "cw" })).toBe("AA1ZZ · 20 m CW");
    expect(reviewTitle({ worked_call: "AA1ZZ", band: null, mode: null })).toBe("AA1ZZ");
    expect(reviewDetail({ contact_time: "2026-10-27T20:44:00Z", candidates: [] }, NOW))
      .toBe("Oct 27, 20:44 UTC · No POTA spot for this station within 30 minutes of when you logged it.");
    const two = [{ reference: "US-2763", name: "Hanging Rock State Park" }, { reference: "US-2764", name: "Pilot Mountain State Park" }];
    expect(reviewDetail({ contact_time: "2026-10-26T15:10:00Z", candidates: two }, NOW))
      .toBe("Oct 26, 15:10 UTC · Spotted at two different parks around then: Hanging Rock State Park and Pilot Mountain State Park.");
    expect(reviewDetail({ contact_time: "2026-10-26T15:10:00Z", candidates: [...two, { reference: "K-0001", name: null }] }, NOW))
      .toBe("Oct 26, 15:10 UTC · Spotted at three different parks around then: Hanging Rock State Park, Pilot Mountain State Park and K-0001.");
    expect(reviewBanner(2)).toBe("2 logged contacts need a look before they can count toward Parks.");
    expect(reviewBanner(1)).toBe("1 logged contact needs a look before it can count toward Parks.");
    expect(joinNames([])).toBe("");
    expect(joinNames(["A"])).toBe("A");
  });
});

describe("the relay", () => {
  const relay = { status: "recent" as const, last_contact_at: "2026-10-29T11:48:00Z", logger_app: "N1MM", relay_count: 1 };

  it("words the relay's last contact", () => {
    expect(relayLine(relay, NOW, false)).toBe("N1MM · Last contact 12 minutes ago");
    expect(relayLine(relay, NOW, true)).toBe("Last contact 12 minutes ago");
    expect(relayLine({ ...relay, logger_app: null, last_contact_at: "2026-10-29T09:00:00Z" }, NOW, false)).toBe("Last contact 3 hours ago");
    expect(relayLine({ ...relay, last_contact_at: "2026-10-27T09:00:00Z" }, NOW, true)).toBe("Last contact 2 days ago");
    const stale = { ...relay, status: "stale" as const, last_contact_at: "2026-10-20T10:00:00Z" };
    expect(relayLine(stale, NOW, false)).toBe("Last contact Oct 20, 9 days ago");
    expect(relayLine({ ...stale, last_contact_at: null }, NOW, false)).toBe("No contacts yet");
    expect(relayBannerText(stale, NOW)).toBe(
      "The relay hasn't sent a contact in 9 days. Contacts you log while it's off won't mark anything worked, and your connections will keep alerting for them. Open the relay on your logging computer, or mark entries by hand.",
    );
    expect(relayBannerText({ ...stale, status: "never", last_contact_at: null }, NOW)).toMatch(/^The relay hasn't sent a contact yet\. Contacts/);
  });

  it("shows the banner only on an active list marked from the log while the relay is quiet", () => {
    expect(showRelayBanner(card(), { status: "stale" })).toBe(true);
    expect(showRelayBanner(card(), { status: "never" })).toBe(true);
    expect(showRelayBanner(card(), { status: "recent" })).toBe(false);
    expect(showRelayBanner(card({ marking: "hand" }), { status: "stale" })).toBe(false);
    expect(showRelayBanner(card({ status: "ended" }), { status: "stale" })).toBe(false);
  });

  it("remembers Dismiss for 7 days per list, and survives a storage that throws", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(relayDismissed(store, "n1", NOW)).toBe(false);
    dismissRelay(store, "n1", NOW);
    expect(data.get(dismissKey("n1"))).toBe(String(NOW.getTime() + 7 * 86_400_000));
    expect(dismissKey("n1")).toBe("longlines.goalRelayDismissed.n1");
    expect(relayDismissed(store, "n1", new Date(NOW.getTime() + 6 * 86_400_000))).toBe(true);
    expect(relayDismissed(store, "n1", new Date(NOW.getTime() + 8 * 86_400_000))).toBe(false);
    expect(relayDismissed(store, "n2", NOW)).toBe(false);
    expect(relayDismissed(null, "n1", NOW)).toBe(false);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(relayDismissed(broken, "n1", NOW)).toBe(false);
    expect(() => dismissRelay(broken, "n1", NOW)).not.toThrow();
  });

  it("has no storage outside a browser", () => {
    expect(browserStorage()).toBeNull();
  });
});

describe("connections", () => {
  it("words a connection's source and destinations", () => {
    expect(connectionDetail({ sources: ["pota"], destination_count: 1 })).toBe("Parks on the Air · 1 destination");
    expect(connectionDetail({ sources: ["dxcluster"], destination_count: 2 })).toBe("DX Cluster · 2 destinations");
    expect(connectionDetail({ sources: [], destination_count: 0 })).toBe("All sources · 0 destinations");
    expect(connectionDetail({ sources: ["pota", "sotawatch"], destination_count: 1 })).toBe("POTA, SOTAwatch · 1 destination");
  });

  it("words the Used by note by status", () => {
    expect(usedByNote("active", 2)).toBe("Every connection using this goal stops alerting for entries you've worked.");
    expect(usedByNote("complete", 2)).toBe("The goal rule is off on both connections.");
    expect(usedByNote("complete", 1)).toBe("The goal rule is off on this connection.");
    expect(usedByNote("ended", 2)).toBe("The goal rule is off on both connections while this goal is ended.");
    expect(usedByNote("ended", 3)).toBe("The goal rule is off on all 3 connections while this goal is ended.");
  });

  it("words the Complete and Ended banners", () => {
    expect(completeText(3)).toBe("All 3 requirements are complete. Nice work.");
    expect(completeText(1)).toBe("The requirement is complete. Nice work.");
    expect(completeRuleBanner([])).toBeNull();
    expect(completeRuleBanner([{ name: "POTA states, CW" }, { name: "DX states" }])).toEqual({
      title: "The goal rule is now off on 2 connections",
      text: "POTA states, CW and DX states no longer filter by this goal, so they alert for everything their other rules allow. Add a different goal to them, or delete this one once no connection uses it.",
    });
    expect(completeRuleBanner([{ name: "DX states" }])?.title).toBe("The goal rule is now off on 1 connection");
    expect(endedBanner(card({ status: "ended" }), 2)).toEqual({
      title: "This goal ended Dec 31, 2026",
      text: "46 entries were still needed. It no longer counts new contacts, and the goal rule is now off on the 2 connections using it, so they alert for everything their other rules allow. Change the dates to turn it back on.",
    });
    expect(endedBanner(card({ status: "ended", worked: 63 }), 1).text).toMatch(/^1 entry was still needed\. .* the 1 connection using it, so it alerts/);
    expect(endedBanner(card({ status: "ended" }), 0).text).toBe("46 entries were still needed. It no longer counts new contacts. Change the dates to turn it back on.");
    expect(endedBanner(card({ ends_on: null }), 0).title).toBe("This goal ended");
    expect(copyYear(card(), NOW)).toBe(2027);
    expect(copyYear(card({ ends_on: null }), NOW)).toBe(2027);
    expect(blockedDeleteText(2)).toBe("2 connections use this goal. Remove the goal rule from each one, then you can delete it.");
    expect(blockedDeleteText(1)).toBe("1 connection uses this goal. Remove the goal rule from it, then you can delete it.");
    expect(requirementsLine(0, 3, "active")).toBe("0 of 3 requirements complete");
    expect(requirementsLine(0, 3, "ended")).toBe("Final: 0 of 3 requirements complete");
  });
});
