import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { STATE_SHAPES } from "./stateShapes";
import { UsStateMap } from "./UsStateMap";

describe("UsStateMap", () => {
  it("draws every state and labels the scale with the busiest count", () => {
    const { container } = renderPage(<UsStateMap values={{ NC: 1200, CA: 300 }} />);
    expect(container.querySelectorAll("path")).toHaveLength(STATE_SHAPES.length);
    expect(screen.getByText("1,200 spots")).toBeInTheDocument();
  });

  it("shades active states and leaves idle ones neutral", () => {
    const { container } = renderPage(<UsStateMap values={{ NC: 10 }} />);
    const fills = new Set([...container.querySelectorAll("path")].map((p) => p.getAttribute("fill")));
    expect(fills.size).toBe(2);
  });

  it("shows a per-state tooltip on hover", async () => {
    const { container, user } = renderPage(<UsStateMap values={{ NC: 10 }} />);
    const nc = STATE_SHAPES.findIndex((s) => s.code === "NC");
    await user.hover(container.querySelectorAll("path")[nc]!);
    expect(await screen.findByText("North Carolina: 10 spots")).toBeInTheDocument();
  });

  it("handles a week with no activity", () => {
    renderPage(<UsStateMap values={{}} />);
    expect(screen.getByText("0 spots")).toBeInTheDocument();
  });
});

describe("UsStateMap units", () => {
  it("names what it counts in the label, tooltip and legend", async () => {
    const { container, user } = renderPage(<UsStateMap values={{ NC: 3 }} unit="activations" />);
    expect(screen.getByRole("img", { name: "Map of activations by state" })).toBeInTheDocument();
    expect(screen.getByText("3 activations")).toBeInTheDocument();
    const nc = STATE_SHAPES.findIndex((s) => s.code === "NC");
    await user.hover(container.querySelectorAll("path")[nc]!);
    expect(await screen.findByText("North Carolina: 3 activations")).toBeInTheDocument();
  });
});
