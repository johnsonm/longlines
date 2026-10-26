// cty.dat, AD1C's country file (https://www.country-files.com/), parsed into
// the rows load_cty stores. Profiles use it to say which country and continent
// each spotter is in; the lookup itself is SQL (cty_lookup), never TypeScript.
//
// One record per entity, terminated by ";":
//   United States:            05:  08:  NA:   37.60:    91.87:     5.0:  K:
//       AA,AB,...,K,N,W,=4U1WB(5)[8],=AA0BY(3)[6],...;
// Header fields: name, CQ zone, ITU zone, continent, latitude, longitude (west
// positive), UTC offset, primary prefix. The aliases are prefixes, or exact
// callsigns when they start with "=", each optionally followed by overrides:
// (CQ zone) [ITU zone] <lat/lon> {continent} ~UTC offset~.
//
// A primary prefix starting with "*" marks a DARC WAE entity (Sicily, European
// Turkey, ...), not a DXCC one. Those records are skipped so their calls fall
// through to the parent country (IT9 -> I, Italy). "=VERyyyymmdd" carries the
// file's version and "=VERSION" is a marker; neither is a callsign.

import { ValidationError } from "./errors.ts";
import { fetchText } from "./http.ts";

export const CTY_URL = "https://www.country-files.com/cty/cty.dat";

const CONTINENTS = new Set(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]);
const ALIAS = /^(=?)([A-Z0-9/]+)((?:\(\d+\)|\[\d+\]|<[^>]*>|\{[A-Z]{2}\}|~[^~]*~)*)$/;
const VERSION = /^VER(\d{8})$/;

export interface CtyEntity {
  /** Primary prefix, the entity's key (K, 3D2/c). */
  prefix: string;
  name: string;
  continent: string;
  cq_zone: number;
  itu_zone: number;
  lat: number;
  /** East positive (cty.dat writes west positive). */
  lon: number;
}

export interface CtyPrefix {
  /** A prefix, or a whole callsign when exact. */
  pattern: string;
  exact: boolean;
  entity: string;
  continent: string;
  cq_zone: number;
  itu_zone: number;
}

export interface CtyData {
  /** yyyymmdd from the =VER entry, or null when the file has none. */
  version: string | null;
  entities: CtyEntity[];
  prefixes: CtyPrefix[];
}

/** The file did not parse: cty.dat is third-party text, so this is a ValidationError. */
function ctyError(message: string): ValidationError {
  return new ValidationError(`cty.dat: ${message}`, {
    cause: undefined,
    where: "parseCty: cty.dat",
  });
}

/** A zone number: a positive integer (Number("") would be 0). */
function zone(text: string, what: string): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1) {
    throw ctyError(`bad ${what} "${text}"`);
  }
  return n;
}

function num(text: string, what: string): number {
  const n = Number(text);
  if (text === "" || !Number.isFinite(n)) {
    throw ctyError(`bad ${what} "${text}"`);
  }
  return n;
}

function continent(text: string, where: string): string {
  if (!CONTINENTS.has(text)) {
    throw ctyError(`bad continent "${text}" in ${where}`);
  }
  return text;
}

/** Header field i, trimmed, or "" when the record has fewer fields. */
function field(fields: string[], i: number): string {
  const f = fields[i];
  if (f === undefined) {
    return "";
  }
  return f.trim();
}

/**
 * Capture group i of an ALIAS or VERSION match. Their groups always take part
 * (group 3 of ALIAS may match empty), so undefined only means the token was bad.
 */
function group(m: RegExpExecArray, i: number, token: string, name: string): string {
  const g = m[i];
  if (g === undefined) {
    throw ctyError(`bad alias "${token}" in ${name}`);
  }
  return g;
}

/** The first capture group of re in text, or undefined when re does not match. */
function capture(re: RegExp, text: string): string | undefined {
  const m = re.exec(text);
  if (m === null) {
    return undefined;
  }
  return m[1];
}

/** Parses a whole cty.dat. Throws on a malformed record rather than loading part of a file. */
export function parseCty(text: string): CtyData {
  let version: string | null = null;
  const entities: CtyEntity[] = [];
  const prefixes: CtyPrefix[] = [];
  const seen = new Set<string>();
  // Every record ends with ";", so a body cut off mid-download does not.
  if (!text.trimEnd().endsWith(";")) {
    throw ctyError('does not end with ";" (truncated download?)');
  }

  for (const raw of text.split(";")) {
    const record = raw.trim();
    if (record === "") {
      continue;
    }
    const fields = record.split(":");
    if (fields.length !== 9) {
      throw ctyError(`expected 8 header fields in "${record.slice(0, 60)}"`);
    }
    // Field 6 is the UTC offset, which nothing stores.
    const name = field(fields, 0);
    const cq = field(fields, 1);
    const itu = field(fields, 2);
    const cont = field(fields, 3);
    const lat = field(fields, 4);
    const lon = field(fields, 5);
    const primary = field(fields, 7);
    const aliasText = field(fields, 8);
    if (primary.startsWith("*")) {
      continue;
    }

    const entity: CtyEntity = {
      prefix: primary,
      name,
      continent: continent(cont, name),
      cq_zone: zone(cq, `CQ zone for ${name}`),
      itu_zone: zone(itu, `ITU zone for ${name}`),
      lat: num(lat, `latitude for ${name}`),
      lon: -num(lon, `longitude for ${name}`),
    };
    entities.push(entity);

    for (const token of aliasText.split(",").map((t) => t.trim()).filter((t) => t !== "")) {
      const m = ALIAS.exec(token);
      if (m === null) {
        throw ctyError(`bad alias "${token}" in ${name}`);
      }
      const exact = m[1] === "=";
      const pattern = group(m, 2, token, name);
      const overrides = group(m, 3, token, name);
      if (exact) {
        const v = VERSION.exec(pattern);
        if (v !== null) {
          version = group(v, 1, token, name);
          continue;
        }
        if (pattern === "VERSION") {
          continue;
        }
      }
      // A pattern listed twice keeps its first entity, as loggers do.
      let key = pattern;
      if (exact) {
        key = `=${pattern}`;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const cqOverride = capture(/\((\d+)\)/, overrides);
      const ituOverride = capture(/\[(\d+)\]/, overrides);
      const contOverride = capture(/\{([A-Z]{2})\}/, overrides);
      let prefixContinent = entity.continent;
      if (contOverride !== undefined && contOverride !== "") {
        prefixContinent = continent(contOverride, token);
      }
      let cqZone = entity.cq_zone;
      if (cqOverride !== undefined && cqOverride !== "") {
        cqZone = Number(cqOverride);
      }
      let ituZone = entity.itu_zone;
      if (ituOverride !== undefined && ituOverride !== "") {
        ituZone = Number(ituOverride);
      }
      prefixes.push({
        pattern,
        exact,
        entity: entity.prefix,
        continent: prefixContinent,
        cq_zone: cqZone,
        itu_zone: ituZone,
      });
    }
  }
  return { version, entities, prefixes };
}

/** GETs cty.dat with the Long Lines User-Agent. */
export async function fetchCty(url: string): Promise<string> {
  return await fetchText(url, { timeoutMs: 30_000 });
}
