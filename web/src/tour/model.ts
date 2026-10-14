// The guided tour's steps, copy and state machine. Pure: no React, no DOM, no Joyride.
// TourProvider turns STEPS into Joyride steps; pages report TourEvents as they happen.

export const TOUR_EVENTS = [
  "destination-dialog-opened",
  "destination-dialog-closed",
  "destination-created",
  "secret-dismissed",
  "test-sent",
  "subscription-dialog-opened",
  "subscription-dialog-closed",
  "subscription-form-opened",
  "subscription-form-cancelled",
  "subscription-created",
] as const;
export type TourEvent = (typeof TOUR_EVENTS)[number];

export type TourRoute = "/destinations" | "/subscriptions" | "/subscriptions/new";

/** Body copy; an object segment renders as a link that opens in a new tab. */
export type Segment = string | { text: string; href: string };

export interface TourStep {
  id: string;
  route: TourRoute;
  /** `data-tour` attribute value of the element to point at, or null for a centered step. */
  target: string | null;
  title: string;
  body: Segment[];
  /** "next" shows a primary button; an event name waits for the page to report it. */
  advanceOn: "next" | TourEvent;
  /**
   * An event that sends the tour back one step. Form steps use it: when the dialog they point at
   * is cancelled, the target unmounts, so the tour returns to the button that opens it.
   */
  backOn?: TourEvent;
  /** The step `backOn` returns to, by id, when it isn't the one before. */
  backTo?: string;
  /**
   * A page the step's own action moves to before it reports `advanceOn`. Landing there doesn't
   * end the tour; the next step's route is that page.
   */
  leadsTo?: TourRoute;
  /** Primary button label on "next" steps. Defaults to Next (Done on the last step). */
  nextLabel?: string;
  /** Tooltip side; ignored for centered steps. Defaults to bottom. */
  placement?: "top" | "bottom" | "left" | "right";
  /** Steps that spotlight a whole form drop the dimmed overlay so the form stays usable. */
  hideOverlay?: boolean;
  /** Shows a "Got it" button that hides the tooltip until the step advances (event steps only). */
  dismissible?: boolean;
}

export const TOUR_ENDED_TOAST = "Tour ended. You can take it again from the account menu.";
/** Account-menu entry that starts the tour. The mock has no tour, so this copy lives here. */
export const TOUR_MENU_LABEL = "Take the tour";

export const STEPS: readonly TourStep[] = [
  {
    id: "welcome", route: "/destinations", target: null, advanceOn: "next", nextLabel: "Start",
    title: "Welcome to Long Lines",
    body: ["Long Lines watches POTA and SOTAwatch and delivers the spots you care about. This tour takes about two minutes: you'll add a webhook destination, send it a test, and create your first subscription."],
  },
  {
    id: "add-destination", route: "/destinations", target: "add-destination", advanceOn: "destination-dialog-opened",
    title: "Add a destination",
    body: ["A destination is a place spots get delivered. Click Add destination."],
  },
  {
    id: "destination-form", route: "/destinations", target: "destination-form", advanceOn: "destination-created", backOn: "destination-dialog-closed",
    placement: "right", hideOverlay: true, dismissible: true,
    title: "Point it at webhook.site",
    body: [
      "Choose Webhook. Then open ", { text: "webhook.site", href: "https://webhook.site" },
      " in a new tab, copy the URL it gives you, and paste it as the Endpoint URL. Give it a name like Tour test and click Add destination.",
    ],
  },
  {
    id: "secret", route: "/destinations", target: "signing-secret", advanceOn: "secret-dismissed", placement: "bottom", hideOverlay: true,
    title: "Your signing secret",
    body: ["Every delivery is signed with this secret so your server can verify it came from Long Lines. You won't need it for webhook.site. Click Done."],
  },
  {
    id: "send-test", route: "/destinations", target: "send-test", advanceOn: "test-sent",
    title: "Send a test",
    body: ["Click Send test. Long Lines posts one sample spot from N0CALL to your URL. Switch to the webhook.site tab to see the request and its JSON body."],
  },
  {
    id: "to-subscriptions", route: "/destinations", target: null, advanceOn: "next",
    title: "Now pick your spots",
    body: ["Delivery works. Next, a subscription chooses which spots to send."],
  },
  {
    id: "new-subscription", route: "/subscriptions", target: "new-subscription", advanceOn: "subscription-dialog-opened",
    title: "Create a subscription",
    body: ["Click New subscription."],
  },
  {
    // Anchored to Continue, not the list: on a phone the dialog is full screen.
    id: "pick-source", route: "/subscriptions", target: "source-continue", advanceOn: "subscription-form-opened",
    backOn: "subscription-dialog-closed", leadsTo: "/subscriptions/new", placement: "top", hideOverlay: true, dismissible: true,
    title: "Pick a source",
    body: ["A subscription takes spots from one source. Parks on the Air is a good start. Click Continue."],
  },
  {
    // Anchored to the save button at the top of the page, so the tooltip never covers the form.
    id: "subscription-form", route: "/subscriptions/new", target: "subscription-save", advanceOn: "subscription-created",
    backOn: "subscription-form-cancelled", backTo: "new-subscription", placement: "bottom", hideOverlay: true, dismissible: true,
    title: "Choose what to receive",
    body: ["Name it, then add rules to narrow what passes: callsigns, groups, bands, modes, or a park, summit, or location. With no rules every spot passes. Under Destinations, click Add destination and choose your webhook. The preview shows how many recent spots would pass. Click Save subscription."],
  },
  {
    id: "done", route: "/subscriptions", target: null, advanceOn: "next", nextLabel: "Done",
    title: "You're on the air",
    body: ["Matching spots now go to your webhook as they come in. When you're ready for a real endpoint, add it as a new destination and point the subscription at it. You can take this tour again from the account menu."],
  },
];

export interface TourState {
  active: boolean;
  index: number;
  /** The destination created during this tour, so the page can mark its Send test button. */
  destinationId: string | null;
  /** The current step's tooltip was hidden with "Got it"; cleared when the step advances. */
  dismissed: boolean;
}

export const INITIAL: TourState = { active: false, index: 0, destinationId: null, dismissed: false };

export type TourAction =
  | { type: "start" }
  | { type: "next" }
  | { type: "dismiss" }
  | { type: "end" }
  | { type: "event"; event: TourEvent; destinationId?: string; secret?: boolean };

function advance(state: TourState, to: number): TourState {
  return to >= STEPS.length ? { ...state, active: false } : { ...state, index: to, dismissed: false };
}

export function reduce(state: TourState, action: TourAction): TourState {
  switch (action.type) {
    case "start":
      return { active: true, index: 0, destinationId: null, dismissed: false };
    case "end":
      return state.active ? { ...state, active: false } : state;
    case "dismiss": {
      const step = STEPS[state.index];
      if (!state.active || !step?.dismissible || state.dismissed) return state;
      return { ...state, dismissed: true };
    }
    case "next": {
      const step = STEPS[state.index];
      if (!state.active || !step || step.advanceOn !== "next") return state;
      return advance(state, state.index + 1);
    }
    case "event": {
      const step = STEPS[state.index];
      if (!state.active || !step) return state;
      if (step.backOn === action.event) {
        const to = step.backTo ? STEPS.findIndex((x) => x.id === step.backTo) : state.index - 1;
        return { ...state, index: Math.max(0, to), dismissed: false };
      }
      if (step.advanceOn !== action.event) return state;
      let to = state.index + 1;
      // A Discord destination has no secret, so there is no secret dialog to point at.
      if (action.secret === false && STEPS[to]?.advanceOn === "secret-dismissed") to += 1;
      const destinationId = action.destinationId ?? state.destinationId;
      return advance({ ...state, destinationId }, to);
    }
  }
}
