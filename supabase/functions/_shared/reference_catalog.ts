// The programs' reference lists (POTA parks, SOTA summits, WWFF references), parsed into the
// rows load-references stages. The relay streams each file (relay/catalogs.ts) and calls these;
// the swap into reference_catalog is SQL (apply_reference_loads), never TypeScript.
//
// Each file is CSV with a header row (SOTA's has a title line before it). Columns are found by
// header name, never by position, so a column the program adds or moves changes nothing. Only
// the columns in the spec's mapping leave the parser
// (docs/superpowers/specs/2026-10-26-reference-profiles-design.md, "Catalog").
//
// The CSV reader is hand-written (RFC 4180 plus a BOM and bare LF line ends) rather than a
// dependency: the relay's import map is exactly the packages it loads, and the reader is a small
// state machine that has to stream anyway.
//
// The imports are errors.ts, which imports nothing, and zod, which the relay (which loads this
// module) maps.

import { z } from "zod";
import { ValidationError } from "./errors.ts";

export const REFERENCE_PROGRAMS = ["pota", "sota", "wwff"] as const;
export type ReferenceProgram = typeof REFERENCE_PROGRAMS[number];

/** One reference as staged: reference_catalog's columns. Dates are YYYY-MM-DD. */
export interface ReferenceCatalogRow {
  /** Upper case; letters and digits joined by `/` and `-`. */
  reference: string;
  name: string | null;
  active: boolean;
  /** POTA locationDesc: `US-NC,US-VA`. */
  location: string | null;
  /** SOTA `{AssociationName}, {RegionName}`; WWFF the state, or the region without one. */
  region: string | null;
  /** WWFF's `country`, which stage_reference_rows replaces with cty.dat's entity for `dxcc`. */
  country: string | null;
  /**
   * WWFF's DXCC prefix (K, VK9N). SQL resolves the country from it (cty_lookup in
   * stage_reference_rows; TypeScript never resolves a call) and does not store it.
   */
  dxcc: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Maidenhead locator; SOTA's derived from its coordinates at POTA's six characters. */
  grid: string | null;
  altitude_m: number | null;
  points: number | null;
  valid_from: string | null;
  valid_to: string | null;
}

/** A record as a row, or a skip (no usable reference: a blank, a repeated header, a test row). */
export type CatalogRecord = { kind: "row"; row: ReferenceCatalogRow } | { kind: "skip" };

// ---------------------------------------------------------------------------------------------
// CSV

/** Longest record CsvRecords keeps, separators counted; real records are under 1 KB. */
export const MAX_CSV_RECORD = 64 * 1024;

const QUOTE = 0x22;
const COMMA = 0x2c;
const CR = 0x0d;
const LF = 0x0a;
const BOM = 0xfeff;

/** Where the reader is: at a field's start, inside an unquoted field, inside quotes, or just after a quote inside quotes. */
type CsvState = "start" | "plain" | "quoted" | "quote";

/**
 * Splits CSV text, fed in chunks of any size, into records of fields (RFC 4180: quoted fields,
 * doubled quotes, commas and line breaks inside quotes, CRLF or LF line ends, a leading BOM).
 * Lenient where the files are: a quote inside an unquoted field, or text after a closing quote,
 * is kept as text. Blank lines are dropped. A record longer than MAX_CSV_RECORD (each separator
 * counts, so a run of empty fields is bounded too), or a file that ends inside quotes, throws, so
 * a malformed file fails the load (the relay abandons it) instead of growing a buffer toward the
 * size of the file.
 */
export class CsvRecords {
  #state: CsvState = "start";
  #field = "";
  #fields: string[] = [];
  #length = 0;
  #first = true;
  #afterCr = false;
  /** "CsvRecords: <file>", the `where` of a ValidationError. */
  readonly #where: string;

  constructor(file: string) {
    this.#where = `CsvRecords: ${file}`;
  }

  /** Records completed by this chunk. */
  push(chunk: string): string[][] {
    const out: string[][] = [];
    let text = chunk;
    if (this.#first && text.length > 0) {
      this.#first = false;
      if (text.charCodeAt(0) === BOM) {
        text = text.slice(1);
      }
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (this.#afterCr) {
        this.#afterCr = false;
        if (c === LF) {
          start = i + 1;
          continue;
        }
      }
      if (this.#state === "quoted") {
        if (c === QUOTE) {
          this.#append(text.slice(start, i));
          this.#state = "quote";
          start = i + 1;
        }
        continue;
      }
      if (this.#state === "quote") {
        if (c === QUOTE) {
          this.#append('"');
          this.#state = "quoted";
          start = i + 1;
          continue;
        }
        this.#state = "plain";
      }
      if (c === COMMA) {
        this.#append(text.slice(start, i));
        this.#endField();
        start = i + 1;
      } else if (c === LF || c === CR) {
        this.#append(text.slice(start, i));
        this.#endRecord(out);
        this.#afterCr = c === CR;
        start = i + 1;
      } else if (c === QUOTE && this.#state === "start") {
        this.#state = "quoted";
        start = i + 1;
      } else {
        this.#state = "plain";
      }
    }
    this.#append(text.slice(start));
    return out;
  }

  /** The record left at the end of the file, if any. */
  flush(): string[][] {
    if (this.#state === "quoted") {
      throw new ValidationError("CSV ends inside a quoted field", {
        cause: undefined,
        where: this.#where,
      });
    }
    const out: string[][] = [];
    this.#endRecord(out);
    return out;
  }

  #append(text: string): void {
    if (text === "") {
      return;
    }
    this.#field += text;
    this.#grow(text.length);
  }

  /** Counts `n` more characters of the record, throwing past MAX_CSV_RECORD. */
  #grow(n: number): void {
    this.#length += n;
    if (this.#length > MAX_CSV_RECORD) {
      throw new ValidationError(`CSV record longer than ${String(MAX_CSV_RECORD)} characters`, {
        cause: undefined,
        where: this.#where,
      });
    }
  }

  #endField(): void {
    this.#grow(1); // the separator, so empty fields count toward the record's length
    this.#fields.push(this.#field);
    this.#field = "";
    this.#state = "start";
  }

  #endRecord(out: string[][]): void {
    this.#endField();
    const fields = this.#fields;
    this.#fields = [];
    this.#length = 0;
    if (fields.length === 1 && fields[0] === "") {
      return; // a blank line
    }
    out.push(fields);
  }
}

// ---------------------------------------------------------------------------------------------
// Values

const REFERENCE = /^[A-Z0-9]+(?:[/-][A-Z0-9]+)+$/;
const MAX_REFERENCE = 64;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const INTEGER = /^-?\d+$/;
/** A locator of four or six characters, or an extended one whose further pairs are dropped. */
const LOCATOR = /^([A-R]{2})(\d{2})(?:([A-X]{2})(?:\d{2}(?:[A-X]{2})?)?)?$/i;
/** A WWFF state that names a subdivision (K-PA, VK-VIC), not a prefix (R, TA) or K-???. */
const SUBDIVISION = /^[A-Z0-9/]+-[A-Z0-9]+$/i;
const DMY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The square of 0, 0: what the lists give a reference with no coordinates. */
const NULL_ISLAND_GRID = "JJ00aa";

/** Trimmed with runs of white space as one space; null when blank or a `-` placeholder. */
function text(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed === "" || trimmed === "-") {
    return null;
  }
  return trimmed;
}

function integer(value: string | undefined): number | null {
  const t = text(value);
  if (t === null || !INTEGER.test(t)) {
    return null;
  }
  const n = Number(t);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 2_147_483_647) {
    return null;
  }
  return n;
}

function decimal(value: string | undefined, limit: number): number | null {
  const t = text(value);
  if (t === null || !DECIMAL.test(t)) {
    return null;
  }
  const n = Number(t);
  if (Math.abs(n) > limit) {
    return null;
  }
  return n;
}

interface Coordinates {
  latitude: number | null;
  longitude: number | null;
}

/** Both coordinates or neither; 0, 0 is the lists' placeholder for none. */
function coordinates(latitude: string | undefined, longitude: string | undefined): Coordinates {
  const lat = decimal(latitude, 90);
  const lon = decimal(longitude, 180);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) {
    return { latitude: null, longitude: null };
  }
  return { latitude: lat, longitude: lon };
}

/**
 * A locator as POTA writes it (FN54vh), or null when it is not one or is 0, 0's square. An
 * extended locator (FJ88PH53) keeps its first six characters.
 */
export function normalizeGrid(value: string | undefined): string | null {
  let t = text(value);
  if (t === null) {
    return null;
  }
  // WWFF writes a few as -GJ01PN, - KN16xk or KN34BL-.
  t = t.replace(/^[-\s]+|[-\s]+$/g, "");
  const m = LOCATOR.exec(t);
  if (m === null) {
    return null;
  }
  const grid = `${group(m, 1).toUpperCase()}${group(m, 2)}${group(m, 3).toLowerCase()}`;
  if (grid === NULL_ISLAND_GRID || grid === NULL_ISLAND_GRID.slice(0, 4)) {
    return null;
  }
  return grid;
}

const A = "A".charCodeAt(0);
const LOWER_A = "a".charCodeAt(0);

/** The six-character Maidenhead locator of a point (FN54vh), the length POTA's file uses. */
export function maidenhead(latitude: number, longitude: number): string {
  // Just under the top edge, so 90 N or 180 E stays inside the last field.
  const lon = Math.min(longitude + 180, 360 - 1e-9);
  const lat = Math.min(latitude + 90, 180 - 1e-9);
  const fieldLon = Math.floor(lon / 20);
  const fieldLat = Math.floor(lat / 10);
  const squareLon = Math.floor((lon % 20) / 2);
  const squareLat = Math.floor(lat % 10);
  const subLon = Math.floor((lon % 2) * 12);
  const subLat = Math.floor((lat % 1) * 24);
  return String.fromCharCode(A + fieldLon, A + fieldLat) +
    `${String(squareLon)}${String(squareLat)}` +
    String.fromCharCode(LOWER_A + subLon, LOWER_A + subLat);
}

/** Capture group i, "" when it did not take part (the locator's optional subsquare). */
function group(m: RegExpExecArray, i: number): string {
  const g = m[i];
  if (g === undefined) {
    return "";
  }
  return g;
}

/** The trimmed value, "" when absent. */
function plain(value: string | undefined): string {
  const t = text(value);
  if (t === null) {
    return "";
  }
  return t;
}

/** yyyy-mm-dd when it is a calendar date, else null. */
function isoDate(yyyy: string, mm: string, dd: string): string | null {
  const iso = `${yyyy}-${mm}-${dd}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (isNaN(date.getTime()) || !date.toISOString().startsWith(iso)) {
    return null;
  }
  return iso;
}

/** SOTA's DD/MM/YYYY as YYYY-MM-DD; null when blank or not a calendar date. */
export function sotaDate(value: string | undefined): string | null {
  const m = DMY.exec(plain(value));
  if (m === null) {
    return null;
  }
  return isoDate(group(m, 3), group(m, 2), group(m, 1));
}

/** WWFF's YYYY-MM-DD; null when blank, 0000-00-00 (none) or not a calendar date. */
export function wwffDate(value: string | undefined): string | null {
  const m = YMD.exec(plain(value));
  if (m === null) {
    return null;
  }
  return isoDate(group(m, 1), group(m, 2), group(m, 3));
}

/** The UTC day of `now`, YYYY-MM-DD. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The reference upper-cased, or null when it is not one (a blank, a repeated header row). */
function reference(value: string | undefined): string | null {
  const t = text(value);
  if (t === null) {
    return null;
  }
  const upper = t.toUpperCase();
  if (upper.length > MAX_REFERENCE || !REFERENCE.test(upper)) {
    return null;
  }
  return upper;
}

// ---------------------------------------------------------------------------------------------
// Programs

/** A record's fields by header name. */
type Field = (name: string) => string | undefined;

interface ProgramFormat {
  /** The file, for messages. */
  file: string;
  /** Header names the mapping reads; a header without one of them is refused. */
  columns: readonly string[];
  map(field: Field, now: Date): CatalogRecord;
}

/** A row with every optional column null. */
function emptyRow(ref: string, active: boolean): ReferenceCatalogRow {
  return {
    reference: ref,
    name: null,
    active,
    location: null,
    region: null,
    country: null,
    dxcc: null,
    latitude: null,
    longitude: null,
    grid: null,
    altitude_m: null,
    points: null,
    valid_from: null,
    valid_to: null,
  };
}

// https://pota.app/all_parks_ext.csv:
// "reference","name","active","entityId","locationDesc","latitude","longitude","grid"
const POTA: ProgramFormat = {
  file: "all_parks_ext.csv",
  columns: ["reference", "name", "active", "locationDesc", "latitude", "longitude", "grid"],
  map(field): CatalogRecord {
    const ref = reference(field("reference"));
    if (ref === null) {
      return { kind: "skip" };
    }
    const out = emptyRow(ref, text(field("active")) === "1");
    out.name = text(field("name"));
    out.location = text(field("locationDesc"));
    const point = coordinates(field("latitude"), field("longitude"));
    out.latitude = point.latitude;
    out.longitude = point.longitude;
    // POTA gives a park without coordinates (0, 0) the grid of 0, 0 too.
    if (point.latitude !== null) {
      out.grid = normalizeGrid(field("grid"));
    }
    return { kind: "row", row: out };
  },
};

// https://storage.sota.org.uk/summitslist.csv, after its title line
// ("SOTA Summits List (Date=26/10/2026)"):
// SummitCode,AssociationName,RegionName,SummitName,AltM,AltFt,GridRef1,GridRef2,Longitude,
// Latitude,Points,BonusPoints,ValidFrom,ValidTo,ActivationCount,ActivationDate,ActivationCall
const SOTA: ProgramFormat = {
  file: "summitslist.csv",
  columns: [
    "SummitCode",
    "AssociationName",
    "RegionName",
    "SummitName",
    "AltM",
    "Longitude",
    "Latitude",
    "Points",
    "ValidFrom",
    "ValidTo",
  ],
  map(field, now): CatalogRecord {
    const ref = reference(field("SummitCode"));
    if (ref === null) {
      return { kind: "skip" };
    }
    const validTo = sotaDate(field("ValidTo"));
    // ValidTo is the summit's last valid day (31/12/2099 for a current one).
    const out = emptyRow(ref, validTo === null || validTo >= utcDay(now));
    out.name = text(field("SummitName"));
    const region = [text(field("AssociationName")), text(field("RegionName"))]
      .filter((part) => part !== null)
      .join(", ");
    if (region !== "") {
      out.region = region;
    }
    const point = coordinates(field("Latitude"), field("Longitude"));
    out.latitude = point.latitude;
    out.longitude = point.longitude;
    if (point.latitude !== null && point.longitude !== null) {
      out.grid = maidenhead(point.latitude, point.longitude);
    }
    out.altitude_m = integer(field("AltM"));
    out.points = integer(field("Points"));
    out.valid_from = sotaDate(field("ValidFrom"));
    out.valid_to = validTo;
    return { kind: "row", row: out };
  },
};

// https://wwff.co/wwff-data/wwff_directory.csv:
// reference,status,name,program,dxcc,state,county,continent,iota,iaruLocator,latitude,longitude,
// IUCNcat,validFrom,validTo,notes,lastMod,changeLog,reviewFlag,specialFlags,website,country,
// region,dxccEnum,qsoCount,lastAct
const WWFF: ProgramFormat = {
  file: "wwff_directory.csv",
  columns: [
    "reference",
    "status",
    "name",
    "dxcc",
    "state",
    "iaruLocator",
    "latitude",
    "longitude",
    "validFrom",
    "validTo",
    "country",
    "region",
  ],
  map(field): CatalogRecord {
    const ref = reference(field("reference"));
    if (ref === null) {
      return { kind: "skip" };
    }
    // `state` is a subdivision (K-PA, VK-VIC) or, without one, a prefix: the DXCC prefix again
    // (SM), or another (R for RA, TA for TA2), or a placeholder (K-???). `region` is free text
    // (Pennsylvania, Laen O). The state when it names a subdivision, else the region.
    const dxcc = text(field("dxcc"));
    let region = text(field("state"));
    if (region !== null && (region === dxcc || !SUBDIVISION.test(region))) {
      region = null;
    }
    if (region === null) {
      region = text(field("region"));
    }
    const out = emptyRow(ref, text(field("status")) === "active");
    out.name = text(field("name"));
    out.region = region;
    out.country = text(field("country"));
    out.dxcc = dxcc;
    const point = coordinates(field("latitude"), field("longitude"));
    out.latitude = point.latitude;
    out.longitude = point.longitude;
    out.grid = normalizeGrid(field("iaruLocator"));
    out.valid_from = wwffDate(field("validFrom"));
    out.valid_to = wwffDate(field("validTo"));
    return { kind: "row", row: out };
  },
};

const FORMATS: Readonly<Record<ReferenceProgram, ProgramFormat>> = {
  pota: POTA,
  sota: SOTA,
  wwff: WWFF,
};

/** The upstream file's name, for messages and fixtures. */
export function catalogFile(program: ReferenceProgram): string {
  return FORMATS[program].file;
}

/** Records before the header that ReferenceCatalogParser passes over (SOTA's title line). */
export const MAX_LINES_BEFORE_HEADER = 5;

/**
 * Maps one record to a row, given the header's column positions. Exported for tests; the relay
 * uses ReferenceCatalogParser.
 */
export function mapCatalogRecord(
  program: ReferenceProgram,
  header: ReadonlyMap<string, number>,
  record: readonly string[],
  now: Date,
): CatalogRecord {
  function field(name: string): string | undefined {
    const index = header.get(name);
    if (index === undefined) {
      return undefined;
    }
    return record[index];
  }
  return FORMATS[program].map(field, now);
}

/**
 * Streams one program's file into rows: finds the header by name (passing over a title line
 * before it), then maps each record. `skipped` counts records without a usable reference.
 */
export class ReferenceCatalogParser {
  readonly #program: ReferenceProgram;
  readonly #format: ProgramFormat;
  readonly #now: Date;
  readonly #csv: CsvRecords;
  #header: Map<string, number> | null = null;
  #beforeHeader = 0;
  skipped = 0;

  constructor(program: ReferenceProgram, now: Date) {
    this.#program = program;
    this.#format = FORMATS[program];
    this.#now = now;
    this.#csv = new CsvRecords(this.#format.file);
  }

  /** Rows completed by this chunk. */
  push(chunk: string): ReferenceCatalogRow[] {
    return this.#take(this.#csv.push(chunk));
  }

  /** The rows left at the end of the file; throws when the file never had its header. */
  flush(): ReferenceCatalogRow[] {
    const rows = this.#take(this.#csv.flush());
    if (this.#header === null) {
      throw this.#noHeader();
    }
    return rows;
  }

  #take(records: string[][]): ReferenceCatalogRow[] {
    const rows: ReferenceCatalogRow[] = [];
    for (const record of records) {
      if (this.#header === null) {
        this.#readHeader(record);
        continue;
      }
      const result = mapCatalogRecord(this.#program, this.#header, record, this.#now);
      if (result.kind === "skip") {
        this.skipped += 1;
      } else {
        rows.push(result.row);
      }
    }
    return rows;
  }

  /** Takes the record as the header when it names every column the mapping reads. */
  #readHeader(record: string[]): void {
    const names = new Map<string, number>();
    for (let index = 0; index < record.length; index++) {
      const key = plain(record[index]);
      if (!names.has(key)) {
        names.set(key, index);
      }
    }
    if (this.#format.columns.every((column) => names.has(column))) {
      this.#header = names;
      return;
    }
    this.#beforeHeader += 1;
    if (this.#beforeHeader > MAX_LINES_BEFORE_HEADER) {
      throw this.#noHeader();
    }
  }

  #noHeader(): ValidationError {
    return new ValidationError(
      `${this.#format.file} has no header with ${this.#format.columns.join(", ")}`,
      { cause: undefined, where: `ReferenceCatalogParser: ${this.#format.file}` },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// load-references: requests and replies

/** A program's last applied load, from reference_load_status. */
export interface AppliedReferenceLoad {
  /** The file's Last-Modified header. */
  version: string;
  /** When its load began: the relay measures the week from it (relay/catalogs.ts shouldLoad). */
  started_at: string;
  applied_at: string;
  rows: number;
}

export type ReferenceLoadState = "staging" | "finished" | "applied" | "refused" | "abandoned";

/** A program's newest load, from reference_load_status. */
export interface NewestReferenceLoad {
  id: number;
  version: string;
  state: ReferenceLoadState;
  rows: number;
  started_at: string;
  finished_at: string | null;
}

/** One program's loads: either may be null. */
export interface ProgramLoadStatus {
  applied: AppliedReferenceLoad | null;
  newest: NewestReferenceLoad | null;
}

/** reference_load_status' jsonb: one entry per program. */
export type ReferenceLoadStatus = Record<ReferenceProgram, ProgramLoadStatus>;

// RPC jsonb that can gain keys across deploys: loose.
const programLoadStatusSchema: z.ZodType<ProgramLoadStatus> = z.looseObject({
  applied: z.looseObject({
    version: z.string(),
    started_at: z.string(),
    applied_at: z.string(),
    rows: z.number(),
  }).nullable(),
  newest: z.looseObject({
    id: z.number(),
    version: z.string(),
    state: z.enum(["staging", "finished", "applied", "refused", "abandoned"]),
    rows: z.number(),
    started_at: z.string(),
    finished_at: z.string().nullable(),
  }).nullable(),
});

/** reference_load_status' jsonb, as db.ts reads it and as load-references hands it to the relay. */
export const referenceLoadStatusSchema: z.ZodType<ReferenceLoadStatus> = z.looseObject({
  pota: programLoadStatusSchema,
  sota: programLoadStatusSchema,
  wwff: programLoadStatusSchema,
});

/** finish_reference_load's answer: refused when incomplete or below the floor (decision 3). */
export type ReferenceFinishState = "finished" | "refused";

export const referenceFinishStateSchema: z.ZodType<ReferenceFinishState> = z.enum([
  "finished",
  "refused",
]);

/** What the relay POSTs to load-references, one action per request. */
export type LoadReferencesRequest =
  | { action: "status" }
  | { action: "begin"; program: ReferenceProgram; version: string }
  | { action: "rows"; load: number; rows: ReferenceCatalogRow[] }
  | { action: "finish"; load: number; rows: number }
  | { action: "abandon"; load: number; error: string };

/**
 * Most rows load-references takes in one request. A row is about 200 bytes of JSON, so a full
 * request is about 1 MB and one insert of that many rows stays well inside the 8 s API timeout.
 */
export const MAX_REFERENCE_ROWS_PER_REQUEST = 5_000;

// The replies load-references sends (_shared/handlers/load_references.ts), read by the relay
// (relay/catalogs.ts). Our own function's replies, so strict; the status inside the status reply
// is reference_load_status' jsonb, read with the schema db.ts reads it with (loose).

/** status: every program's loads. */
export interface ReferenceStatusReply {
  status: ReferenceLoadStatus;
}

export const referenceStatusReplySchema: z.ZodType<ReferenceStatusReply> = z.strictObject({
  status: referenceLoadStatusSchema,
});

/** begin: the new load's id. */
export interface ReferenceBeginReply {
  load: number;
}

export const referenceBeginReplySchema: z.ZodType<ReferenceBeginReply> = z.strictObject({
  load: z.number(),
});

/** rows: the load's rows staged so far (right even for a retried batch). */
export interface ReferenceRowsReply {
  staged: number;
}

export const referenceRowsReplySchema: z.ZodType<ReferenceRowsReply> = z.strictObject({
  staged: z.number(),
});

/** finish: whether the load was finished or refused. */
export interface ReferenceFinishReply {
  state: ReferenceFinishState;
}

export const referenceFinishReplySchema: z.ZodType<ReferenceFinishReply> = z.strictObject({
  state: referenceFinishStateSchema,
});

/** abandon. */
export interface ReferenceAbandonReply {
  ok: true;
}

export const referenceAbandonReplySchema: z.ZodType<ReferenceAbandonReply> = z.strictObject({
  ok: z.literal(true),
});
