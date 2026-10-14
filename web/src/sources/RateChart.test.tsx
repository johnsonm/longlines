import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderPage } from "../test/render";
import { RateChart } from "./RateChart";
import type { Rates } from "./rates";

const hours = Array.from({ length: 168 }, (_, i) => new Date(Date.UTC(2026, 9, 7) + i * 3_600_000).toISOString().replace(".000", ""));
const rates: Rates = { series: hours.map((_, i) => (i === 125 ? 11.8 : 3)), hours, average: 3.1, peak: 11.8, peakHour: hours[125] ?? "", minimum: 3, perDay: 4600 };

describe("RateChart", () => {
  // formatRate gives whole numbers from 10, so a peak of 11.8 reads "12".
  it("labels the peak with its value and hour", () => {
    renderPage(<RateChart rates={rates} volume="high" color="warning" />);
    expect(screen.getByText("Peak 12 / min, Oct 12, 05:00 UTC")).toBeInTheDocument();
  });

  it("marks the peak with a circle, the dot the copy promises", () => {
    const { container } = renderPage(<RateChart rates={rates} volume="high" color="warning" />);
    const marks = container.querySelectorAll(".MuiLineChart-mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute("d")).not.toBe("M-4,-4h8v8h-8Z");
  });

  it("uses per-hour units for a standard source", () => {
    renderPage(<RateChart rates={{ ...rates, peak: 88 }} volume="standard" color="primary" />);
    expect(screen.getByText(/^Peak 88 \/ hour,/)).toBeInTheDocument();
  });

  it("draws a planned source's grey mark colour", () => {
    renderPage(<RateChart rates={rates} volume="standard" color="default" />);
    expect(screen.getByText(/^Peak 12 \/ hour,/)).toBeInTheDocument();
  });
});
