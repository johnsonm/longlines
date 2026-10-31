// The user docs are a separate site, so both navs open it in a new tab rather than routing.
export const DOCS_URL = "https://docs.longlines.io";

/** The nav item a path belongs to: its first segment, with a callsign profile under Callsign lookup. */
export function navSection(pathname: string): string {
  const section = pathname.replace(/^\//, "").split("/")[0] ?? "";
  return section === "call" ? "lookup" : section;
}
