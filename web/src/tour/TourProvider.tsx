// The only module that imports react-joyride. It was added for the guided tour because
// it provides the spotlight overlay, tooltip positioning and target polling that the
// hands-on tour needs; writing that against MUI portals ourselves would be far larger.
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { Link, useTheme } from "@mui/material";
import { useLocation, useNavigate } from "react-router";
import { ACTIONS, EVENTS, Joyride, type EventData, type Step } from "react-joyride";
import { useApp } from "../app/hooks";
import { TourContext, type TourDetail, type TourValue } from "./context";
import { INITIAL, reduce, STEPS, TOUR_ENDED_TOAST, type Segment, type TourEvent, type TourStep } from "./model";

const TARGET_WAIT_MS = 3000;
const LOCALE = { next: "Next", last: "Done", skip: "Skip tour" };
/** The element Joyride renders its tooltip and overlay into (a child of document.body). */
const JOYRIDE_PORTAL_ID = "react-joyride-portal";

function body(segments: Segment[]) {
  return segments.map((s, i) =>
    typeof s === "string" ? s : <Link key={i} href={s.href} target="_blank" rel="noopener">{s.text}</Link>,
  );
}

function toJoyrideStep(step: TourStep): Step {
  const waits = step.advanceOn !== "next";
  // On a dismissible step the primary button hides the tooltip instead of advancing.
  const primary = step.dismissible ? "Got it" : step.nextLabel;
  return {
    id: step.id,
    target: step.target === null ? "body" : `[data-tour="${step.target}"]`,
    placement: step.target === null ? "center" : (step.placement ?? "bottom"),
    title: step.title,
    content: body(step.body),
    buttons: waits && !step.dismissible ? ["skip"] : ["primary", "skip"],
    hideOverlay: step.hideOverlay ?? false,
    locale: primary ? { next: primary, last: primary } : undefined,
  };
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const { notify, session } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const step = STEPS[state.index];
  const route = state.active ? step?.route : undefined;
  const leadsTo = state.active ? step?.leadsTo : undefined;
  // Set while the tour itself is navigating to a step's page, so that move isn't mistaken for the user leaving.
  const pendingRoute = useRef<string | null>(null);
  // The step-entry effect must run only when the step changes, never on navigation: `navigate`
  // from BrowserRouter changes identity with the location, so both it and the path live in refs.
  const pathRef = useRef(location.pathname);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    pathRef.current = location.pathname;
    navigateRef.current = navigate;
  });

  // Entering a step on another page: go there.
  useEffect(() => {
    if (!route || pathRef.current === route) return;
    pendingRoute.current = route;
    void navigateRef.current(route);
  }, [route, state.index]);

  // Any other navigation away from the step's page ends the tour. Signing out also lands here;
  // the toast mentions the account menu, so a signed-out user gets no toast.
  useEffect(() => {
    if (!route) return;
    if (location.pathname === route) {
      pendingRoute.current = null;
      return;
    }
    if (pendingRoute.current === route) return;
    // The step's own action goes there; its event follows and moves the tour on.
    if (location.pathname === leadsTo) return;
    dispatch({ type: "end" });
    if (session) notify(TOUR_ENDED_TOAST);
  }, [location.pathname, route, leadsTo, notify, session]);

  // While an MUI Dialog is open its Modal marks every other child of <body> aria-hidden, which
  // includes Joyride's portal, so the form steps' tooltips would be hidden from assistive
  // technology. Undo that for the portal alone for as long as the tour runs.
  useEffect(() => {
    if (!state.active) return;
    const unhide = () => {
      const portal = document.getElementById(JOYRIDE_PORTAL_ID);
      if (portal?.getAttribute("aria-hidden") === "true") portal.removeAttribute("aria-hidden");
    };
    const observer = new MutationObserver(unhide);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden"] });
    unhide();
    return () => observer.disconnect();
  }, [state.active]);

  const onEvent = useCallback((data: EventData) => {
    if (data.type === EVENTS.STEP_AFTER && data.action === ACTIONS.NEXT) {
      dispatch({ type: STEPS[data.index]?.dismissible ? "dismiss" : "next" });
    } else if (data.type === EVENTS.TOUR_END) {
      dispatch({ type: "end" });
    } else if (data.type === EVENTS.TARGET_NOT_FOUND) {
      dispatch({ type: "end" });
      notify(TOUR_ENDED_TOAST);
    }
  }, [notify]);

  const steps = useMemo(() => STEPS.map(toJoyrideStep), []);
  // Joyride deep-compares its props on every render, so keep these objects stable.
  const options = useMemo(() => ({
    zIndex: theme.zIndex.modal + 50,
    disableFocusTrap: true,
    overlayClickAction: false as const,
    dismissKeyAction: false as const,
    closeButtonAction: "skip" as const,
    skipBeacon: true,
    targetWaitTimeout: TARGET_WAIT_MS,
    backgroundColor: theme.palette.background.paper,
    arrowColor: theme.palette.background.paper,
    textColor: theme.palette.text.primary,
    primaryColor: theme.palette.primary.main,
    width: "min(380px, calc(100vw - 32px))",
  }), [theme]);
  const start = useCallback(() => dispatch({ type: "start" }), []);
  const report = useCallback((event: TourEvent, detail?: TourDetail) => dispatch({ type: "event", event, ...detail }), []);
  const value = useMemo<TourValue>(
    () => ({ active: state.active, destinationId: state.destinationId, start, report }),
    [state.active, state.destinationId, start, report],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
      <Joyride
        steps={steps}
        run={!!route && location.pathname === route && !state.dismissed}
        stepIndex={state.index}
        continuous
        onEvent={onEvent}
        locale={LOCALE}
        options={options}
      />
    </TourContext.Provider>
  );
}
