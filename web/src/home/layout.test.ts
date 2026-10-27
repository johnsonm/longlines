import { describe, expect, it } from "vitest";
import { columnHeight, linkPaths, linkWidth, NODE_HEIGHT, rowCenters } from "./layout";

describe("columnHeight", () => {
  it("fits the rows 12 px apart", () => {
    expect(columnHeight(7)).toBe(7 * 56 + 6 * 12);
    expect(columnHeight(1)).toBe(56);
    expect(columnHeight(0)).toBe(0);
  });
});

describe("rowCenters", () => {
  it("spreads rows as justify-content: space-between does", () => {
    // The canvas: five sources in a 464 px column.
    expect(rowCenters(5, 464)).toEqual([28, 130, 232, 334, 436]);
  });

  it("puts the first and last rows flush with the column", () => {
    const rows = rowCenters(3, 300);
    expect(rows[0]).toBe(NODE_HEIGHT / 2);
    expect(rows[2]).toBe(300 - NODE_HEIGHT / 2);
  });

  it("leaves a lone row at the top", () => {
    expect(rowCenters(1, 464)).toEqual([28]);
    expect(rowCenters(0, 464)).toEqual([]);
  });
});

describe("linkWidth", () => {
  it("is log-scaled with a 2 px floor", () => {
    expect(linkWidth(0)).toBe(2);
    expect(linkWidth(1)).toBe(2);
    expect(linkWidth(2)).toBe(2);
    expect(linkWidth(10)).toBeCloseTo(2 * Math.log(10) - 1.5);
    expect(linkWidth(100)).toBeCloseTo(2 * Math.log(100) - 1.5);
    expect(linkWidth(1000)).toBeGreaterThan(linkWidth(100));
  });
});

describe("linkPaths", () => {
  it("draws a cubic bezier between the two rows' centres", () => {
    const [path] = linkPaths(2, 2, 124, [{ from: 0, to: 1, value: 1 }]);
    expect(path).toEqual({ d: "M0 28 C50 28 50 96 100 96", width: 2, y1: 28, y2: 96 });
  });

  it("stacks links that share a node edge, ordered by the other end and centred on the node", () => {
    const w = linkWidth(500);
    const paths = linkPaths(1, 2, 124, [
      { from: 0, to: 1, value: 500 },
      { from: 0, to: 0, value: 2 },
    ]);
    // At the shared source the link to row 0 goes first, then the one to row 1.
    const top = 28 - (2 + w) / 2;
    expect(paths[1]?.y1).toBeCloseTo(top + 1, 1);
    expect(paths[0]?.y1).toBeCloseTo(top + 2 + w / 2, 1);
    // Each target has one link, so it meets the centre.
    expect(paths[0]?.y2).toBe(96);
    expect(paths[1]?.y2).toBe(28);
  });

  it("orders a stack by position, not input order", () => {
    const paths = linkPaths(3, 1, 192, [
      { from: 2, to: 0, value: 1 },
      { from: 0, to: 0, value: 1 },
      { from: 1, to: 0, value: 1 },
    ]);
    // Three 2 px links centred on 28: rows 0, 1, 2 meet at 26, 28, 30.
    expect(paths.map((p) => p.y2)).toEqual([30, 26, 28]);
  });

  it("returns paths in input order with rounded coordinates", () => {
    const paths = linkPaths(3, 3, 192, [
      { from: 0, to: 2, value: 37 },
      { from: 1, to: 1, value: 0 },
    ]);
    expect(paths).toHaveLength(2);
    expect(paths[0]?.d).toMatch(/^M0 28 C50 28 50 164 100 164$/);
    expect(paths[0]?.width).toBe(Math.round(linkWidth(37) * 100) / 100);
    expect(paths[1]?.d).toBe("M0 96 C50 96 50 96 100 96");
  });
});
