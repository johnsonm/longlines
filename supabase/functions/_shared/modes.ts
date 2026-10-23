// Mode canonicalization and families. Pure, no I/O.
//
// This module is the only place that decides what a mode string means.
// raw_spots.mode_family is derived here at ingest; SQL (spot_matches) only
// compares strings and never re-derives the family.

export type ModeFamily = "cw" | "phone" | "digital";

/**
 * Upstream labels that mean "some digital mode" without saying which.
 * SOTAwatch's spot form offers only DATA for every digital mode.
 */
const GENERIC_DIGITAL = new Set(["data", "digi", "digital", "dig"]);

const CW = new Set(["cw"]);
const PHONE = new Set([
  "ssb",
  "usb",
  "lsb",
  "fm",
  "am",
  "dv",
  "dstar",
  "dmr",
  "c4fm",
  "fusion",
  "phone",
]);
const DIGITAL = new Set(
  Array.from(GENERIC_DIGITAL).concat([
    "ft8",
    "ft4",
    "js8",
    "rtty",
    "psk",
    "psk31",
    "psk63",
    "olivia",
    "msk144",
    "jt65",
    "jt9",
    "q65",
    "fst4",
    "fst4w",
    "wspr",
    "sstv",
    "hell",
    "contestia",
    "thor",
    "mfsk",
  ]),
);

/**
 * Specific digital modes an operator might name in a comment when the
 * upstream mode field is blank or generic. An optional space or hyphen is
 * allowed inside ("FT-8", "PSK 31"). Word-bounded so "JS8Call" does not match.
 */
const COMMENT_HINT =
  /\b(ft[ -]?8|ft[ -]?4|js[ -]?8|rtty|psk[ -]?31|psk[ -]?63|olivia|msk[ -]?144|jt[ -]?65|jt[ -]?9|q[ -]?65|fst[ -]?4)\b/i;

/** Lowercase with whitespace and hyphens removed ("FT-8" -> "ft8"). Null when blank. */
export function canonicalMode(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const cleaned = value.toLowerCase().replace(/[\s-]/g, "");
  if (cleaned === "") {
    return null;
  }
  return cleaned;
}

/** The first specific digital mode named in a comment, canonical. Null when none. */
export function modeHintFromComment(comment: string): string | null {
  const match = COMMENT_HINT.exec(comment);
  if (match === null) {
    return null;
  }
  const named = match[1];
  if (named === undefined || named === "") {
    return null;
  }
  return canonicalMode(named);
}

/** Sideband is a detail of SSB; band-plan guesses and filters both say "ssb". */
const SIDEBAND: Record<string, string> = { usb: "ssb", lsb: "ssb" };

/**
 * The mode to store: the canonical upstream value, except that a blank or
 * generic digital label defers to a specific mode named in the comment, and
 * USB/LSB fold to "ssb" (filters offer only "ssb"). An explicit specific
 * upstream mode is never overridden. Content hashes use the raw upstream mode,
 * so folding here never makes a stored spot look new.
 */
export function resolveMode(upstream: string | null | undefined, comment: string): string | null {
  const canonical = canonicalMode(upstream);
  if (canonical === null || GENERIC_DIGITAL.has(canonical)) {
    const hint = modeHintFromComment(comment);
    if (hint !== null) {
      return hint;
    }
    return canonical;
  }
  const folded = SIDEBAND[canonical];
  if (folded !== undefined) {
    return folded;
  }
  return canonical;
}

export function modeFamily(mode: string | null): ModeFamily | null {
  if (mode === null) {
    return null;
  }
  if (CW.has(mode)) {
    return "cw";
  }
  if (PHONE.has(mode)) {
    return "phone";
  }
  if (DIGITAL.has(mode)) {
    return "digital";
  }
  return null;
}

// ---------------------------------------------------------------------------
// DX Cluster only. A cluster spot has no mode field, just free text and a
// frequency, so the mode is read from the comment or guessed from the band
// plan. The other sources keep resolveMode above.

/**
 * Modes an operator names in a DX Cluster comment. Word-bounded, with an
 * optional space or hyphen inside ("FT-8", "D-STAR"). FM and AM are left out on
 * purpose: "tnx fm Italy" and "I am" are far more common than either mode.
 */
const DX_COMMENT_MODE =
  /\b(cw|ssb|usb|lsb|rtty|sstv|wspr|olivia|dmr|c4fm|d[ -]?star|psk[ -]?(?:31|63)?|ft[ -]?8|ft[ -]?4|js[ -]?8|q[ -]?65|msk[ -]?144|jt[ -]?65|jt[ -]?9|fst[ -]?4w?)\b/i;

/** The first mode named in a DX Cluster comment, canonical. Null when none. */
export function modeFromComment(comment: string): string | null {
  const match = DX_COMMENT_MODE.exec(comment);
  if (match === null) {
    return null;
  }
  const named = match[1];
  if (named === undefined || named === "") {
    return null;
  }
  const mode = canonicalMode(named);
  if (mode === null) {
    return null;
  }
  const folded = SIDEBAND[mode];
  if (folded !== undefined) {
    return folded;
  }
  return mode;
}

/** FT8 and FT4 dial frequencies in kHz; a signal sits up to 3 kHz above the dial. */
const FT8_DIALS = [1840, 3573, 5357, 7074, 10136, 14074, 18100, 21074, 24915, 28074, 50313];
const FT4_DIALS = [3575, 7047.5, 10140, 14080, 18104, 21140, 24919, 28180, 50318];
const DIAL_WIDTH_KHZ = 3;

/**
 * IARU band-plan segments in kHz, [from, to). Phone edges follow Region 1 where
 * the regions differ (7060, 14101, 21151), so European phone spots are not left
 * without a mode; Region 2 phone starts higher and lands inside the same range.
 * Gaps (digital sub-bands, beacons, 60m, VHF and up) stay unknown.
 */
const SEGMENTS: ReadonlyArray<{ from: number; to: number; mode: string }> = [
  { from: 1800, to: 1838, mode: "cw" },
  { from: 1843, to: 2000, mode: "ssb" },
  { from: 3500, to: 3570, mode: "cw" },
  { from: 3600, to: 4000, mode: "ssb" },
  { from: 7000, to: 7045, mode: "cw" },
  { from: 7060, to: 7300, mode: "ssb" },
  { from: 10100, to: 10130, mode: "cw" },
  { from: 14000, to: 14070, mode: "cw" },
  { from: 14101, to: 14350, mode: "ssb" },
  { from: 18068, to: 18095, mode: "cw" },
  { from: 18111, to: 18168, mode: "ssb" },
  { from: 21000, to: 21070, mode: "cw" },
  { from: 21151, to: 21450, mode: "ssb" },
  { from: 24890, to: 24915, mode: "cw" },
  { from: 24931, to: 24990, mode: "ssb" },
  { from: 28000, to: 28070, mode: "cw" },
  { from: 28300, to: 29000, mode: "ssb" },
  { from: 29510, to: 29700, mode: "fm" },
  { from: 50000, to: 50100, mode: "cw" },
  { from: 50100, to: 50500, mode: "ssb" },
];

/** The mode the band plan expects at a frequency. Null where the plan does not say. */
export function modeFromFrequency(khz: number): string | null {
  // FT4 first: the 80m windows overlap (3575-3576) and FT4's dial is the exact one there.
  if (nearDial(FT4_DIALS, khz)) {
    return "ft4";
  }
  if (nearDial(FT8_DIALS, khz)) {
    return "ft8";
  }
  const segment = SEGMENTS.find((s) => khz >= s.from && khz < s.to);
  if (segment === undefined) {
    return null;
  }
  return segment.mode;
}

/** True when khz is within DIAL_WIDTH_KHZ above one of the dials. */
function nearDial(dials: number[], khz: number): boolean {
  return dials.some((d) => khz >= d && khz < d + DIAL_WIDTH_KHZ);
}

/** A DX Cluster spot's mode: named in the comment, else the band plan, else null. */
export function resolveDxMode(comment: string, khz: number): string | null {
  const named = modeFromComment(comment);
  if (named !== null) {
    return named;
  }
  return modeFromFrequency(khz);
}
