// The flow diagram's geometry, pure so it can be tested without a browser. Node
// rows sit in fixed-height columns laid out with justify-content: space-between;
// each gap between columns is an SVG with viewBox "0 0 100 <height>", so x runs
// 0 to 100 across the gap and y is in pixels.

export const NODE_HEIGHT = 56;
export const NODE_WIDTH = 220;
export const ROW_GAP = 12;

/** The diagram's height: the fullest column's nodes, ROW_GAP apart. */
export function columnHeight(rows: number): number {
  return rows > 0 ? rows * NODE_HEIGHT + (rows - 1) * ROW_GAP : 0;
}

/** Each row's vertical centre in a column of `height`, as space-between places it (a lone node sits at the top). */
export function rowCenters(count: number, height: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [NODE_HEIGHT / 2];
  const step = NODE_HEIGHT + (height - count * NODE_HEIGHT) / (count - 1);
  return Array.from({ length: count }, (_, i) => i * step + NODE_HEIGHT / 2);
}

/** A link's stroke width in pixels for `n` spots: log-scaled, never under 2. */
export function linkWidth(n: number): number {
  return n > 0 ? Math.max(2, 2 * Math.log(n) - 1.5) : 2;
}

/** A link from row `from` of the left column to row `to` of the right one, carrying `value` spots. */
export interface LinkInput {
  from: number;
  to: number;
  value: number;
}

export interface LinkPath {
  d: string;
  width: number;
  /** Where the link leaves the left node and meets the right one, after stacking. */
  y1: number;
  y2: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Paths for the links between two columns, in input order. Links meeting at one
 * node edge are stacked instead of overlapping: ordered by the row at their other
 * end, each sits below the widths of the ones before it, and the stack is centred
 * on the node.
 */
export function linkPaths(fromRows: number, toRows: number, height: number, links: LinkInput[]): LinkPath[] {
  const widths = links.map((l) => linkWidth(l.value));
  const y1 = stack(links.map((l) => l.from), links.map((l) => l.to), widths, rowCenters(fromRows, height));
  const y2 = stack(links.map((l) => l.to), links.map((l) => l.from), widths, rowCenters(toRows, height));
  return links.map((_, i) => {
    const a = round(y1[i] ?? 0);
    const b = round(y2[i] ?? 0);
    return { d: `M0 ${a} C50 ${a} 50 ${b} 100 ${b}`, width: round(widths[i] ?? 2), y1: a, y2: b };
  });
}

/** The y of each link at one column's edge: `at` is its row there, `other` its row at the far end. */
function stack(at: number[], other: number[], widths: number[], centers: number[]): number[] {
  const out = at.map(() => 0);
  const byRow = new Map<number, number[]>();
  at.forEach((row, i) => byRow.set(row, [...(byRow.get(row) ?? []), i]));
  for (const [row, members] of byRow) {
    members.sort((a, b) => (other[a] ?? 0) - (other[b] ?? 0) || a - b);
    const total = members.reduce((sum, i) => sum + (widths[i] ?? 0), 0);
    let y = (centers[row] ?? 0) - total / 2;
    for (const i of members) {
      const w = widths[i] ?? 0;
      out[i] = y + w / 2;
      y += w;
    }
  }
  return out;
}
