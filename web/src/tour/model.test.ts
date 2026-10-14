import { describe, expect, it } from "vitest";
import { INITIAL, reduce, STEPS, TOUR_EVENTS, type TourAction, type TourState } from "./model";

const started = (): TourState => reduce(INITIAL, { type: "start" });

/** Run the tour forward through the given actions. */
function play(...actions: Parameters<typeof reduce>[1][]): TourState {
  return actions.reduce(reduce, started());
}

const indexOf = (id: string) => STEPS.findIndex((s) => s.id === id);

describe("STEPS", () => {
  it("has unique ids", () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
  });

  it("only waits on known events", () => {
    for (const s of STEPS) {
      if (s.advanceOn !== "next") expect(TOUR_EVENTS).toContain(s.advanceOn);
    }
  });

  it("uses only tour routes and centers next-steps", () => {
    for (const s of STEPS) {
      expect(["/destinations", "/subscriptions", "/subscriptions/new"]).toContain(s.route);
      if (s.target === null) expect(s.advanceOn).toBe("next");
    }
  });

  it("lets the form steps be dismissed, and only event steps", () => {
    expect(STEPS.filter((s) => s.dismissible).map((s) => s.id)).toEqual(["destination-form", "pick-source", "subscription-form"]);
    for (const s of STEPS) {
      if (s.dismissible) expect(s.advanceOn).not.toBe("next");
    }
  });

  it("form steps step back when their dialog closes, and nothing else does", () => {
    expect(STEPS.filter((s) => s.backOn).map((s) => s.id)).toEqual(["destination-form", "pick-source", "subscription-form"]);
    for (const s of STEPS) {
      if (s.backOn) {
        expect(TOUR_EVENTS).toContain(s.backOn);
        expect(s.backOn).not.toBe(s.advanceOn);
      }
      if (s.backTo) expect(indexOf(s.backTo)).toBeGreaterThanOrEqual(0);
    }
  });

  it("a step that leads to another page hands over to a step on that page", () => {
    STEPS.forEach((s, i) => {
      if (s.leadsTo) expect(STEPS[i + 1]?.route).toBe(s.leadsTo);
    });
  });
});

describe("reduce", () => {
  it("start activates at the first step", () => {
    expect(started()).toEqual({ active: true, index: 0, destinationId: null, dismissed: false });
  });

  it("dismiss hides a dismissible step until it advances", () => {
    const form = play({ type: "next" }, { type: "event", event: "destination-dialog-opened" });
    expect(form.index).toBe(indexOf("destination-form"));
    const hidden = reduce(form, { type: "dismiss" });
    expect(hidden.dismissed).toBe(true);
    expect(hidden.index).toBe(form.index);
    const next = reduce(hidden, { type: "event", event: "destination-created", destinationId: "d1", secret: true });
    expect(next.dismissed).toBe(false);
    expect(next.index).toBe(indexOf("secret"));
  });

  it("dismiss is ignored on other steps", () => {
    expect(reduce(started(), { type: "dismiss" })).toEqual(started());
    const button = play({ type: "next" });
    expect(reduce(button, { type: "dismiss" })).toEqual(button);
  });

  it("cancelling the destination dialog returns to the Add destination step", () => {
    const form = play({ type: "next" }, { type: "event", event: "destination-dialog-opened" });
    const back = reduce(form, { type: "event", event: "destination-dialog-closed" });
    expect(back.index).toBe(indexOf("add-destination"));
    expect(back.active).toBe(true);
    // Opening the dialog again picks the form step back up.
    expect(reduce(back, { type: "event", event: "destination-dialog-opened" }).index).toBe(indexOf("destination-form"));
  });

  it("cancelling a dismissed form step also clears the dismissal", () => {
    const hidden = play({ type: "next" }, { type: "event", event: "destination-dialog-opened" }, { type: "dismiss" });
    expect(hidden.dismissed).toBe(true);
    const back = reduce(hidden, { type: "event", event: "destination-dialog-closed" });
    expect(back.dismissed).toBe(false);
    expect(back.index).toBe(indexOf("add-destination"));
  });

  const toSubscriptions = (): TourAction[] => [
    { type: "next" },
    { type: "event", event: "destination-dialog-opened" },
    { type: "event", event: "destination-created", destinationId: "d1", secret: false },
    { type: "event", event: "test-sent" },
    { type: "next" },
  ];

  it("cancelling the source picker returns to the New subscription step", () => {
    const picker = play(...toSubscriptions(), { type: "event", event: "subscription-dialog-opened" });
    expect(picker.index).toBe(indexOf("pick-source"));
    expect(reduce(picker, { type: "event", event: "subscription-dialog-closed" }).index).toBe(indexOf("new-subscription"));
  });

  it("cancelling the subscription form goes back past the picker to New subscription", () => {
    const form = play(
      ...toSubscriptions(),
      { type: "event", event: "subscription-dialog-opened" },
      { type: "event", event: "subscription-form-opened" },
    );
    expect(form.index).toBe(indexOf("subscription-form"));
    expect(reduce(form, { type: "event", event: "subscription-form-cancelled" }).index).toBe(indexOf("new-subscription"));
  });

  it("dialog-closed events are ignored on other steps", () => {
    const button = play({ type: "next" });
    expect(reduce(button, { type: "event", event: "destination-dialog-closed" })).toEqual(button);
    expect(reduce(started(), { type: "event", event: "subscription-dialog-closed" })).toEqual(started());
    expect(reduce(INITIAL, { type: "event", event: "destination-dialog-closed" })).toEqual(INITIAL);
  });

  it("start resets a running tour", () => {
    const mid = play({ type: "next" }, { type: "event", event: "destination-dialog-opened" });
    expect(mid.index).toBe(2);
    expect(reduce(mid, { type: "start" }).index).toBe(0);
  });

  it("next advances only on next-steps", () => {
    expect(play({ type: "next" }).index).toBe(1);
    expect(play({ type: "next" }, { type: "next" }).index).toBe(1);
  });

  it("a matching event advances", () => {
    expect(play({ type: "next" }, { type: "event", event: "destination-dialog-opened" }).index).toBe(2);
  });

  it("ignores events the current step is not waiting for", () => {
    const s = play({ type: "next" }, { type: "event", event: "test-sent" });
    expect(s.index).toBe(1);
    expect(reduce(INITIAL, { type: "event", event: "destination-dialog-opened" })).toEqual(INITIAL);
  });

  it("shows the secret step when a secret was returned", () => {
    const s = play(
      { type: "next" },
      { type: "event", event: "destination-dialog-opened" },
      { type: "event", event: "destination-created", destinationId: "d1", secret: true },
    );
    expect(s.index).toBe(indexOf("secret"));
    expect(s.destinationId).toBe("d1");
  });

  it("skips the secret step when no secret was returned", () => {
    const s = play(
      { type: "next" },
      { type: "event", event: "destination-dialog-opened" },
      { type: "event", event: "destination-created", destinationId: "d1", secret: false },
    );
    expect(s.index).toBe(indexOf("send-test"));
    expect(s.destinationId).toBe("d1");
  });

  it("walks the whole tour in order and ends", () => {
    const s = play(
      { type: "next" },
      { type: "event", event: "destination-dialog-opened" },
      { type: "event", event: "destination-created", destinationId: "d1", secret: true },
      { type: "event", event: "secret-dismissed" },
      { type: "event", event: "test-sent" },
      { type: "next" },
      { type: "event", event: "subscription-dialog-opened" },
      { type: "event", event: "subscription-form-opened" },
      { type: "event", event: "subscription-created" },
    );
    expect(s.index).toBe(STEPS.length - 1);
    expect(s.active).toBe(true);
    expect(reduce(s, { type: "next" }).active).toBe(false);
  });

  it("end deactivates and keeps the index", () => {
    const s = reduce(play({ type: "next" }), { type: "end" });
    expect(s.active).toBe(false);
    expect(reduce(s, { type: "next" })).toEqual(s);
  });
});
