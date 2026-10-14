import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import type { Props as JoyrideProps } from "react-joyride";
import { appValue, tourValue, wrap } from "../test/render";
import type { AppContextValue } from "../app/context";
import { useTour } from "./hooks";
import { STEPS, TOUR_ENDED_TOAST } from "./model";
import { TourProvider } from "./TourProvider";

// Joyride needs real layout to place tooltips. Capture its props instead and
// drive onEvent by hand; TourProvider's job is the mapping and the state.
const joyride = vi.hoisted(() => ({ props: null as JoyrideProps | null }));
vi.mock("react-joyride", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-joyride")>()),
  Joyride: (props: JoyrideProps) => {
    joyride.props = props;
    return <div data-testid="joyride" data-run={String(props.run)} data-index={props.stepIndex} />;
  },
}));
const { ACTIONS, EVENTS } = await import("react-joyride");

// The editor reports subscription-form-opened when it mounts, after the navigation that shows it.
function FormPage() {
  const { report } = useTour();
  useEffect(() => report("subscription-form-opened"), [report]);
  return null;
}

function Probe() {
  const tour = useTour();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="where">{location.pathname}</div>
      <div data-testid="active">{String(tour.active)}</div>
      <div data-testid="dest">{tour.destinationId ?? ""}</div>
      <button onClick={tour.start}>start</button>
      <button onClick={() => tour.report("destination-dialog-opened")}>opened</button>
      <button onClick={() => tour.report("destination-created", { destinationId: "d9", secret: true })}>created</button>
      <button onClick={() => void navigate("/account")}>leave</button>
      <button onClick={() => tour.report("secret-dismissed")}>secret</button>
      <button onClick={() => tour.report("test-sent")}>tested</button>
      <button onClick={() => tour.report("subscription-dialog-opened")}>picker</button>
      <button onClick={() => void navigate("/subscriptions/new?source=pota")}>continue</button>
      {location.pathname === "/subscriptions/new" && <FormPage />}
    </>
  );
}

function setup(app: Partial<AppContextValue> = {}, route = "/sources") {
  const value = appValue(app);
  const user = userEvent.setup();
  render(
    wrap(
      <MemoryRouter initialEntries={[route]}>
        <TourProvider>
          <Probe />
        </TourProvider>
      </MemoryRouter>,
      value,
      tourValue(),
    ),
  );
  const fire = (data: Partial<Parameters<NonNullable<JoyrideProps["onEvent"]>>[0]>) =>
    act(() => joyride.props?.onEvent?.(data as Parameters<NonNullable<JoyrideProps["onEvent"]>>[0], {} as never));
  return { user, app: value, fire, joy: () => screen.getByTestId("joyride") };
}

describe("TourProvider", () => {
  it("maps the tour steps onto Joyride steps", () => {
    setup();
    const steps = joyride.props!.steps;
    expect(steps).toHaveLength(STEPS.length);
    const welcome = steps[0]!;
    expect(welcome).toMatchObject({ target: "body", placement: "center", buttons: ["primary", "skip"], locale: { next: "Start", last: "Start" } });
    const add = steps.find((s) => s.id === "add-destination")!;
    expect(add).toMatchObject({ target: '[data-tour="add-destination"]', placement: "bottom", buttons: ["skip"], locale: undefined });
    const form = steps.find((s) => s.id === "destination-form")!;
    expect(form).toMatchObject({ placement: "right", hideOverlay: true, buttons: ["primary", "skip"], locale: { next: "Got it" } });
  });

  it("renders link segments in step bodies as new-tab links", () => {
    setup();
    const form = joyride.props!.steps.find((s) => s.id === "destination-form")!;
    render(<>{form.content}</>);
    for (const link of screen.getAllByRole("link")) expect(link).toHaveAttribute("target", "_blank");
  });

  it("starting goes to the first step's page and runs there", async () => {
    const { user, joy } = setup();
    expect(joy()).toHaveAttribute("data-run", "false");
    await user.click(screen.getByRole("button", { name: "start" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(STEPS[0]!.route));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(joy()).toHaveAttribute("data-run", "true");
  });

  it("advances on Next and on reported events, and keeps the created destination", async () => {
    const { user, fire, joy } = setup({}, "/destinations");
    await user.click(screen.getByRole("button", { name: "start" }));
    fire({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 0 });
    expect(joy()).toHaveAttribute("data-index", "1");
    await user.click(screen.getByRole("button", { name: "opened" }));
    expect(joy()).toHaveAttribute("data-index", "2");

    // "Got it" on a dismissible step hides the tooltip without advancing.
    fire({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 2 });
    expect(joy()).toHaveAttribute("data-index", "2");
    expect(joy()).toHaveAttribute("data-run", "false");

    await user.click(screen.getByRole("button", { name: "created" }));
    expect(joy()).toHaveAttribute("data-index", "3");
    expect(joy()).toHaveAttribute("data-run", "true");
    expect(screen.getByTestId("dest")).toHaveTextContent("d9");
  });

  it("follows the source picker to the new subscription page without ending", async () => {
    const { user, fire, joy, app } = setup({}, "/destinations");
    await user.click(screen.getByRole("button", { name: "start" }));
    fire({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: 0 });
    for (const name of ["opened", "created", "secret", "tested"]) await user.click(screen.getByRole("button", { name }));
    fire({ type: EVENTS.STEP_AFTER, action: ACTIONS.NEXT, index: STEPS.findIndex((s) => s.id === "to-subscriptions") });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/subscriptions"));
    await user.click(screen.getByRole("button", { name: "picker" }));
    expect(joy()).toHaveAttribute("data-index", String(STEPS.findIndex((s) => s.id === "pick-source")));

    await user.click(screen.getByRole("button", { name: "continue" }));
    await waitFor(() => expect(joy()).toHaveAttribute("data-index", String(STEPS.findIndex((s) => s.id === "subscription-form"))));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("where")).toHaveTextContent("/subscriptions/new");
    expect(joy()).toHaveAttribute("data-run", "true");
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("ignores other Joyride events", async () => {
    const { user, fire, joy } = setup({}, "/destinations");
    await user.click(screen.getByRole("button", { name: "start" }));
    fire({ type: EVENTS.STEP_BEFORE, action: ACTIONS.UPDATE, index: 0 });
    expect(joy()).toHaveAttribute("data-index", "0");
    expect(screen.getByTestId("active")).toHaveTextContent("true");
  });

  it("ends when Joyride finishes or is skipped", async () => {
    const { user, fire, app } = setup({}, "/destinations");
    await user.click(screen.getByRole("button", { name: "start" }));
    fire({ type: EVENTS.TOUR_END, action: ACTIONS.SKIP, index: 0 });
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("ends with a toast when a target never appears", async () => {
    const { user, fire, app } = setup({}, "/destinations");
    await user.click(screen.getByRole("button", { name: "start" }));
    fire({ type: EVENTS.TARGET_NOT_FOUND, action: ACTIONS.UPDATE, index: 1 });
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(app.notify).toHaveBeenCalledWith(TOUR_ENDED_TOAST);
  });

  it("ends with a toast when the user navigates away", async () => {
    const { user, app } = setup({}, "/destinations");
    await user.click(screen.getByRole("button", { name: "start" }));
    await user.click(screen.getByRole("button", { name: "leave" }));
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(app.notify).toHaveBeenCalledWith(TOUR_ENDED_TOAST);
  });

  it("ends quietly when navigation away comes from signing out", async () => {
    const { user, app } = setup({ session: null }, "/destinations");
    await user.click(screen.getByRole("button", { name: "start" }));
    await user.click(screen.getByRole("button", { name: "leave" }));
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(app.notify).not.toHaveBeenCalled();
  });

  it("keeps its portal visible to assistive technology while a dialog is open", async () => {
    const portal = document.createElement("div");
    portal.id = "react-joyride-portal";
    portal.setAttribute("aria-hidden", "true");
    document.body.appendChild(portal);
    try {
      const { user } = setup({}, "/destinations");
      expect(portal).toHaveAttribute("aria-hidden", "true");
      await user.click(screen.getByRole("button", { name: "start" }));
      expect(portal).not.toHaveAttribute("aria-hidden");
      portal.setAttribute("aria-hidden", "true");
      await waitFor(() => expect(portal).not.toHaveAttribute("aria-hidden"));
    } finally {
      portal.remove();
    }
  });

  it("useTour throws outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useTour();
      return null;
    }
    expect(() => render(<Bare />)).toThrow("useTour must be used inside TourProvider");
  });
});
