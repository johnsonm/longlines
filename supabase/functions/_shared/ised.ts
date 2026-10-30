// Innovation, Science and Economic Development Canada (ISED) amateur certificate records
// (amateur_delim.zip / amateur_delim.txt), parsed into rows load-ised-licenses stages.
//
// Each line is semicolon-delimited, starting with a header row:
//   callsign;first_name;surname;address_line;city;prov_cd;postal_code;qual_a;qual_b;qual_c;qual_d;qual_e;club_name;club_name_2;club_address;club_city;club_prov_cd;club_postal_code
//
// PRIVACY MANDATE: Address lines, city, postal codes, and club address details are
// strictly dropped and never staged or stored.

import { z } from "zod";
import { ValidationError } from "./errors.ts";

export const CANADIAN_CALLSIGN = /^(?:C[F-K|Y-Z]|V[A-G|O|X-Y]|X[J-O])[A-Z0-9]{1,7}[A-Z]$/;

export interface IsedRow {
  callsign: string;
  first_name: string | null;
  last_name: string | null;
  club_name: string | null;
  province: string | null;
  qualifications: string;
}

export const isedRowSchema: z.ZodType<IsedRow> = z.strictObject({
  callsign: z.string().min(1).max(32),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  club_name: z.string().nullable(),
  province: z.string().nullable(),
  qualifications: z.string(),
});

export const MAX_ISED_RECORD = 64 * 1024;

export class IsedRecords {
  #partial = "";
  #header: string[] | null = null;
  #skipped = 0;
  readonly #where = "IsedRecords: amateur_delim.txt";

  get skipped(): number {
    return this.#skipped;
  }

  push(chunk: string): IsedRow[] {
    const lines = (this.#partial + chunk).split(/\r?\n/);
    const last = lines.pop();
    if (last === undefined) {
      this.#partial = "";
    } else {
      this.#partial = last;
    }
    if (this.#partial.length > MAX_ISED_RECORD) {
      throw new ValidationError(`ISED line longer than ${String(MAX_ISED_RECORD)} characters`, {
        cause: undefined,
        where: this.#where,
      });
    }

    const rows: IsedRow[] = [];
    function cleanText(val: string | undefined): string | null {
      if (val === undefined) {
        return null;
      }
      let t = val.trim();
      if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        t = t.slice(1, -1).trim();
      }
      if (t === "") {
        return null;
      }
      return t;
    }
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line.trim() === "") {
        continue;
      }
      const fields = line.split(";");

      if (this.#header === null) {
        this.#header = fields.map(function (f) {
          return f.trim().toLowerCase();
        });
        const required = [
          "callsign",
          "first_name",
          "surname",
          "prov_cd",
          "qual_a",
          "qual_b",
          "qual_c",
          "qual_d",
          "qual_e",
          "club_name",
        ];
        for (const req of required) {
          if (!this.#header.includes(req)) {
            throw new ValidationError(`ISED header missing required column: ${req}`, {
              cause: undefined,
              where: this.#where,
            });
          }
        }
        continue;
      }

      const map = new Map<string, string>();
      for (let i = 0; i < this.#header.length; i++) {
        const headerName = this.#header[i];
        const fieldValue = fields[i];
        if (headerName !== undefined) {
          let val = "";
          if (fieldValue !== undefined) {
            val = fieldValue;
          }
          map.set(headerName, val);
        }
      }

      const callVal = map.get("callsign");
      let callsign = "";
      if (callVal !== undefined) {
        callsign = callVal.trim().toUpperCase();
      }
      if (!CANADIAN_CALLSIGN.test(callsign)) {
        this.#skipped++;
        continue;
      }

      const firstName = cleanText(map.get("first_name"));
      const lastName = cleanText(map.get("surname"));
      const cName = cleanText(map.get("club_name"));
      const cName2 = cleanText(map.get("club_name_2"));
      const prov = cleanText(map.get("prov_cd"));
      const qA = cleanText(map.get("qual_a"));
      const qB = cleanText(map.get("qual_b"));
      const qC = cleanText(map.get("qual_c"));
      const qD = cleanText(map.get("qual_d"));
      const qE = cleanText(map.get("qual_e"));

      let clubName: string | null = null;
      if (cName !== null && cName2 !== null) {
        clubName = `${cName} ${cName2}`;
      } else if (cName !== null) {
        clubName = cName;
      } else if (cName2 !== null) {
        clubName = cName2;
      }

      const rawQuals = [qA, qB, qC, qD, qE];
      const filteredQuals: string[] = [];
      for (const q of rawQuals) {
        if (q !== null) {
          filteredQuals.push(q);
        }
      }

      let quals = "";
      let validQuals = true;
      for (const q of filteredQuals) {
        const upper = q.toUpperCase();
        if (upper === "A" || upper === "B" || upper === "C" || upper === "D" || upper === "E") {
          quals += upper;
        } else {
          validQuals = false;
        }
      }

      if (!validQuals) {
        this.#skipped++;
        continue;
      }

      let provCode: string | null = null;
      if (prov !== null && /^[A-Z]{2}$/.test(prov)) {
        provCode = prov;
      }

      rows.push({
        callsign,
        first_name: firstName,
        last_name: lastName,
        club_name: clubName,
        province: provCode,
        qualifications: quals,
      });
    }
    return rows;
  }
}

export const MAX_ISED_ROWS_PER_REQUEST = 5000;

export interface LoadIsedLicensesRequestBase {
  action: string;
}

export interface StatusRequest extends LoadIsedLicensesRequestBase {
  action: "status";
}

export interface BeginRequest extends LoadIsedLicensesRequestBase {
  action: "begin";
  version: string;
}

export interface RowsRequest extends LoadIsedLicensesRequestBase {
  action: "rows";
  load: number;
  rows: IsedRow[];
}

export interface FinishRequest extends LoadIsedLicensesRequestBase {
  action: "finish";
  load: number;
  rows: number;
}

export interface AbandonRequest extends LoadIsedLicensesRequestBase {
  action: "abandon";
  load: number;
  error: string;
}

export type LoadIsedLicensesRequest =
  | StatusRequest
  | BeginRequest
  | RowsRequest
  | FinishRequest
  | AbandonRequest;

export const loadIsedLicensesRequestSchema: z.ZodType<LoadIsedLicensesRequest> = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("status") }),
    z.strictObject({
      action: z.literal("begin"),
      version: z.string().min(1).max(255),
    }),
    z.strictObject({
      action: z.literal("rows"),
      load: z.number().int().min(1),
      rows: z.array(isedRowSchema).min(1).max(MAX_ISED_ROWS_PER_REQUEST),
    }),
    z.strictObject({
      action: z.literal("finish"),
      load: z.number().int().min(1),
      rows: z.number().int().min(0),
    }),
    z.strictObject({
      action: z.literal("abandon"),
      load: z.number().int().min(1),
      error: z.string().min(1).max(1000),
    }),
  ]);
