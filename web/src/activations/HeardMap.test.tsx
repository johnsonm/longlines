import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { createTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { renderPage } from "../test/render";
import { HeardMap } from "./HeardMap";
import { CONTINUED, IOTA, SINGLE, TWOFER } from "./fixtures";

// The test theme's light palette, which the map's colours come from.
const light = createTheme({ colorSchemes: { light: true, dark: true } }).palette;

describe("HeardMap", () => {
  it("draws a line and a labelled dot for each heard state outside the reference's own", () => {
    renderPage(<HeardMap activation={TWOFER} />);
    expect(screen.getByText("Where KK4PWJ was heard")).toBeInTheDocument();
    const lines = screen.getByTestId("heard-lines");
    expect(lines.querySelectorAll("line")).toHaveLength(4);
    for (const code of ["MA", "PA", "NY", "VA"]) expect(within(lines).getByText(code)).toBeInTheDocument();
    expect(within(lines).queryByText("NC")).not.toBeInTheDocument();
    expect(within(lines).getByText("US-1182 · US-1871")).toBeInTheDocument();
    expect(lines.querySelector("line")).toHaveAttribute("stroke", light.primary.main);
  });

  it("shades the reference's own states darker than the heard ones, the rest as UsStateMap does", () => {
    const { container } = renderPage(<HeardMap activation={TWOFER} />);
    const paths = [...container.querySelectorAll("path")];
    const fills = new Set(paths.map((p) => p.getAttribute("fill")));
    expect(fills).toEqual(new Set([alpha(light.primary.main, 0.5), alpha(light.primary.main, 0.16), light.action.hover]));
    expect(paths.filter((p) => p.getAttribute("fill") === alpha(light.primary.main, 0.5))).toHaveLength(1);
    expect(paths.filter((p) => p.getAttribute("fill") === alpha(light.primary.main, 0.16))).toHaveLength(4);
    expect(paths.every((p) => p.getAttribute("stroke") === light.background.paper)).toBe(true);
  });

  it("names one line in the singular, and the map when there are none", () => {
    const { unmount } = renderPage(<HeardMap activation={SINGLE} />);
    expect(screen.getByRole("img", { name: "Lines from Crystal Point State Park to 1 state where KK4PWJ was heard" })).toBeInTheDocument();
    unmount();
    renderPage(<HeardMap activation={{ ...CONTINUED, heard: CONTINUED.heard.filter((p) => p.code === "NC") }} />);
    expect(screen.getByRole("img", { name: "Map of the states where KK4PWJ was heard" })).toBeInTheDocument();
  });

  it("names the references when the first has no name", () => {
    renderPage(<HeardMap activation={{ ...TWOFER, referenceNames: [null, null] }} />);
    expect(screen.getByRole("img", { name: /^Lines from US-1182 · US-1871 to 4 states/ })).toBeInTheDocument();
  });

  it("shades only, and says so, without a location", () => {
    renderPage(<HeardMap activation={IOTA} />);
    expect(screen.queryByTestId("heard-lines")).not.toBeInTheDocument();
    expect(screen.getByText("Location not known for this reference.")).toBeInTheDocument();
    expect(screen.getByText("No spotter's place is known yet.")).toBeInTheDocument();
  });

  it("tells a state's spots on hover", async () => {
    const { user } = renderPage(<HeardMap activation={TWOFER} />);
    await user.hover(within(screen.getByTestId("heard-lines")).getByText("MA"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Massachusetts: 2 spots");
  });
});
