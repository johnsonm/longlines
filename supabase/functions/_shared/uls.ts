// FCC Universal Licensing System amateur records (l_amat.zip), parsed into the
// rows load-licenses stages. The relay streams the zip and calls these; the
// join into callsign_licenses is SQL (apply_license_loads), never TypeScript.
//
// Each .dat file is pipe-delimited, one record per CRLF line, the record type
// first. Field numbers below are 1-based, as in the FCC's public access
// definitions (pa_ddef):
//   HD  2 unique system identifier, 5 call sign, 6 license status,
//       8 grant date, 9 expired date (mm/dd/yyyy)
//   EN  2 unique system identifier, 6 entity type (L = licensee),
//       8 entity name, 9 first name, 10 middle initial, 11 last name,
//       12 suffix, 18 state
//   AM  2 unique system identifier, 6 operator class
// Only these fields leave the parser. EN also carries street address, city,
// ZIP, PO box, phone, email and FRN; none of them is read.
//
// The only import is errors.ts, which imports nothing, so the relay (which loads
// this module) needs no package for it.

import { ValidationError } from "./errors.ts";

export const ULS_KINDS = ["HD", "EN", "AM"] as const;
export type UlsKind = typeof ULS_KINDS[number];

export interface HdRow {
  usi: number;
  callsign: string;
  status: string | null;
  granted_on: string | null;
  expires_on: string | null;
}

export interface EnRow {
  usi: number;
  name: string | null;
  /** The licensee's own first and last names; null for a club, which has only an entity name. */
  first_name: string | null;
  last_name: string | null;
  state: string | null;
}

export interface AmRow {
  usi: number;
  operator_class: string | null;
}

export type UlsRow = HdRow | EnRow | AmRow;

const OPERATOR_CLASSES: Record<string, string> = {
  A: "Advanced",
  E: "Amateur Extra",
  G: "General",
  N: "Novice",
  P: "Technician Plus",
  T: "Technician",
};

/** apply_license_loads prefers the "Active" record when a call has several. */
const STATUSES: Record<string, string> = {
  A: "Active",
  C: "Canceled",
  E: "Expired",
  L: "Pending Legal Status",
  P: "Parent Station Canceled",
  T: "Terminated",
  X: "Term Pending",
};

const CALLSIGN = /^[A-Z0-9]{3,10}$/;
const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function text(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed;
}

/** A code's label, the code itself when unknown, null when blank. */
function label(labels: Record<string, string>, value: string | undefined): string | null {
  const code = text(value);
  if (code === null) {
    return null;
  }
  const named = labels[code];
  if (named === undefined) {
    return code;
  }
  return named;
}

/** Capture group i of a DATE match; DATE's groups always take part, so "" is never used. */
function group(m: RegExpExecArray, i: number): string {
  const g = m[i];
  if (g === undefined) {
    return "";
  }
  return g;
}

/** mm/dd/yyyy as yyyy-mm-dd; null when blank or not a calendar date. */
export function ulsDate(value: string | undefined): string | null {
  let trimmed = "";
  if (value !== undefined) {
    trimmed = value.trim();
  }
  const m = DATE.exec(trimmed);
  if (m === null) {
    return null;
  }
  const mm = group(m, 1);
  const dd = group(m, 2);
  const yyyy = group(m, 3);
  const iso = `${yyyy}-${mm}-${dd}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (isNaN(date.getTime())) {
    return null;
  }
  if (!date.toISOString().startsWith(iso)) {
    return null;
  }
  return iso;
}

function usi(value: string | undefined): number | null {
  if (value === undefined || value === "") {
    return null;
  }
  if (!/^\d{1,15}$/.test(value)) {
    return null;
  }
  return Number(value);
}

/**
 * One record of the given file as a staging row, or null when it is not one
 * (another record type, no system identifier or call sign, or an EN entity
 * other than the licensee).
 */
export function parseUlsRecord(kind: UlsKind, record: string): UlsRow | null {
  const f = record.split("|");
  if (f[0] !== kind) {
    return null;
  }
  const id = usi(f[1]);
  if (id === null) {
    return null;
  }

  switch (kind) {
    case "HD": {
      let callsign = "";
      const callField = f[4];
      if (callField !== undefined) {
        callsign = callField.trim().toUpperCase();
      }
      if (!CALLSIGN.test(callsign)) {
        return null;
      }
      return {
        usi: id,
        callsign,
        status: label(STATUSES, f[5]),
        granted_on: ulsDate(f[7]),
        expires_on: ulsDate(f[8]),
      };
    }
    case "EN": {
      const entityType = f[5];
      if (entityType === undefined || entityType.trim() !== "L") {
        return null;
      }
      const person = [f[8], f[9], f[10], f[11]].map(text).filter((p) => p !== null);
      const first = text(f[8]);
      const last = text(f[10]);
      let state: string | null = null;
      const stateText = text(f[17]);
      if (stateText !== null) {
        state = stateText.toUpperCase();
      }
      // Individuals have first and last names; clubs only an entity name.
      let name: string | null;
      if ((first !== null && first !== "") || (last !== null && last !== "")) {
        name = person.join(" ");
      } else {
        name = text(f[7]);
      }
      let stateCode: string | null = null;
      if (state !== null && state !== "" && /^[A-Z]{2}$/.test(state)) {
        stateCode = state;
      }
      return {
        usi: id,
        name,
        first_name: first,
        last_name: last,
        state: stateCode,
      };
    }
    case "AM":
      return { usi: id, operator_class: label(OPERATOR_CLASSES, f[5]) };
  }
}

/** Longest record or unterminated line UlsRecords keeps; real records are under 1 KB. */
export const MAX_ULS_RECORD = 64 * 1024;

/**
 * Splits decoded .dat text into records. A record is a line that starts with
 * the file's record type; any other line continues the previous record (a
 * field with a line break in it), joined with a space. A line or record longer
 * than MAX_ULS_RECORD throws, so a malformed file fails the load (the relay
 * abandons it) instead of growing a buffer toward the size of the file.
 */
export class UlsRecords {
  #partial = "";
  #record: string | null = null;
  readonly #prefix: string;
  /** "UlsRecords: HD.dat", the `where` of a ValidationError. */
  readonly #where: string;

  constructor(kind: UlsKind) {
    this.#prefix = `${kind}|`;
    this.#where = `UlsRecords: ${kind}.dat`;
  }

  /** Records completed by this chunk. */
  push(chunk: string): string[] {
    const lines = (this.#partial + chunk).split("\n");
    const last = lines.pop();
    if (last === undefined) {
      this.#partial = "";
    } else {
      this.#partial = last;
    }
    if (this.#partial.length > MAX_ULS_RECORD) {
      throw new ValidationError(`ULS line longer than ${String(MAX_ULS_RECORD)} characters`, {
        cause: undefined,
        where: this.#where,
      });
    }
    return this.#take(lines);
  }

  /** The records left at the end of the file. */
  flush(): string[] {
    const out = this.#take([this.#partial]);
    this.#partial = "";
    if (this.#record !== null) {
      out.push(this.#record);
    }
    this.#record = null;
    return out;
  }

  #take(lines: string[]): string[] {
    const out: string[] = [];
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith(this.#prefix)) {
        if (this.#record !== null) {
          out.push(this.#record);
        }
        this.#record = line;
      } else if (line !== "" && this.#record !== null) {
        this.#record += ` ${line}`;
      }
      if (this.#record !== null && this.#record.length > MAX_ULS_RECORD) {
        throw new ValidationError(`ULS record longer than ${String(MAX_ULS_RECORD)} characters`, {
          cause: undefined,
          where: this.#where,
        });
      }
    }
    return out;
  }
}

/** The newest load of an authority's registry, from fcc_license_load_status. */
export interface LicenseLoad {
  id: number;
  /** The file's Last-Modified header. */
  version: string;
  status: "loading" | "ready" | "applied" | "failed";
  started_at: string;
}

/** Rows staged per file. */
export type UlsCounts = Record<UlsKind, number>;

/** What the relay POSTs to load-licenses, one action per request. */
export type LoadLicensesRequest =
  | { action: "status" }
  | { action: "begin"; version: string }
  | { action: "rows"; load: number; kind: UlsKind; rows: UlsRow[] }
  | { action: "finish"; load: number; counts: UlsCounts }
  | { action: "abandon"; load: number; error: string };

/** Most rows load-licenses takes in one request. */
export const MAX_ROWS_PER_REQUEST = 10_000;
