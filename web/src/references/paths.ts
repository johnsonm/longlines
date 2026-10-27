// The one place a reference page's path is built. Only programs with pages
// (POTA, SOTA, WWFF) link; WWBOTA bunkers and IOTA islands have none yet.

import type { ReferenceProgram } from "./types";

export const REFERENCE_PROGRAMS: readonly ReferenceProgram[] = ["pota", "sota", "wwff"];

/** A program as the route spells it, from a payload's name ("POTA") or the route itself ("pota"); null without a page. */
export function referenceProgram(program: string): ReferenceProgram | null {
  const lower = program.toLowerCase();
  return REFERENCE_PROGRAMS.find((p) => p === lower) ?? null;
}

// Source ids whose spots name a reference with a page.
const SOURCE_PROGRAMS: Record<string, ReferenceProgram> = { pota: "pota", sotawatch: "sota", wwff: "wwff" };

/** The program of a source's references ("sotawatch" is SOTA); null for a source without reference pages. */
export function sourceProgram(source: string): ReferenceProgram | null {
  return SOURCE_PROGRAMS[source] ?? null;
}

/** The source a reference's alerts come from: SOTA spots arrive through SOTAwatch. */
export function programSource(program: ReferenceProgram): string {
  return program === "sota" ? "sotawatch" : program;
}

/**
 * "/ref/sota/W4C/CM-001": the program lower-cased and the reference as given, each segment encoded,
 * SOTA's "/" kept as a path separator. Null for a program without pages, a blank reference, or a
 * "." or ".." segment, which the router would resolve to another page.
 */
export function referencePath(program: string, reference: string): string | null {
  const p = referenceProgram(program);
  if (!p || !reference) return null;
  const segments = reference.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return `/ref/${p}/${segments.map(encodeURIComponent).join("/")}`;
}

/** The canonical, shareable link of a reference page. */
export function referenceUrl(origin: string, program: ReferenceProgram, reference: string): string {
  return `${origin}${referencePath(program, reference) ?? "/"}`;
}
