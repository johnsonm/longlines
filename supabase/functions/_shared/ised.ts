// Innovation, Science and Economic Development Canada (ISED) amateur certificate records
// (amateur_delim.zip / amateur_delim.txt), parsed into rows load-ised-licenses stages.
//
// Each line is semicolon-delimited with no quoting, starting with a header row:
//   callsign;first_name;surname;address_line;city;prov_cd;postal_code;qual_a;qual_b;qual_c;qual_d;qual_e;club_name;club_name_2;club_address;club_city;club_prov_cd;club_postal_code
//
// PRIVACY MANDATE: Address lines, city, postal codes, and club address details are
// strictly dropped and never staged or stored.

import { z } from "zod";
import { cleanIsedText, IsedDelimReader, MAX_ISED_RECORD } from "./ised_delim.ts";
import { type LicenseLoad, licenseLoadSchema } from "./uls.ts";

export { MAX_ISED_RECORD };

export const CANADIAN_CALLSIGN = /^(?:C[F-KYZ]|V[A-GOXY]|X[J-O])[A-Z0-9]{1,7}[A-Z]$/;

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

const REQUIRED_COLUMNS = [
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

export class IsedRecords {
  readonly #reader = new IsedDelimReader("IsedRecords: amateur_delim.txt", REQUIRED_COLUMNS);
  #skipped = 0;

  get skipped(): number {
    return this.#reader.skipped + this.#skipped;
  }

  push(chunk: string): IsedRow[] {
    return this.#parse(this.#reader.push(chunk));
  }

  flush(): IsedRow[] {
    return this.#parse(this.#reader.flush());
  }

  #parse(maps: Map<string, string>[]): IsedRow[] {
    const rows: IsedRow[] = [];
    for (const map of maps) {
      const callVal = map.get("callsign");
      let callsign = "";
      if (callVal !== undefined) {
        callsign = callVal.trim().toUpperCase();
      }
      if (!CANADIAN_CALLSIGN.test(callsign)) {
        this.#skipped++;
        continue;
      }

      const firstName = cleanIsedText(map.get("first_name"));
      const lastName = cleanIsedText(map.get("surname"));
      const cName = cleanIsedText(map.get("club_name"));
      const cName2 = cleanIsedText(map.get("club_name_2"));
      const prov = cleanIsedText(map.get("prov_cd"));
      const qA = cleanIsedText(map.get("qual_a"));
      const qB = cleanIsedText(map.get("qual_b"));
      const qC = cleanIsedText(map.get("qual_c"));
      const qD = cleanIsedText(map.get("qual_d"));
      const qE = cleanIsedText(map.get("qual_e"));

      let clubName: string | null = null;
      if (cName !== null && cName2 !== null) {
        clubName = `${cName} ${cName2}`;
      } else if (cName !== null) {
        clubName = cName;
      } else if (cName2 !== null) {
        clubName = cName2;
      }

      let validQuals = true;
      let quals = "";
      if (qA !== null) {
        if (qA.toUpperCase() === "A") {
          quals += "A";
        } else {
          validQuals = false;
        }
      }
      if (qB !== null) {
        if (qB.toUpperCase() === "B") {
          quals += "B";
        } else {
          validQuals = false;
        }
      }
      if (qC !== null) {
        if (qC.toUpperCase() === "C") {
          quals += "C";
        } else {
          validQuals = false;
        }
      }
      if (qD !== null) {
        if (qD.toUpperCase() === "D") {
          quals += "D";
        } else {
          validQuals = false;
        }
      }
      if (qE !== null) {
        if (qE.toUpperCase() === "E") {
          quals += "E";
        } else {
          validQuals = false;
        }
      }

      if (!validQuals) {
        this.#skipped++;
        continue;
      }

      let provCode: string | null = null;
      if (prov !== null) {
        const upperProv = prov.toUpperCase();
        if (/^[A-Z]{2}$/.test(upperProv)) {
          provCode = upperProv;
        }
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

/** Result of ised_license_load_status(): newest load plus newest applied started_at. */
export interface IsedLoadStatus {
  load: LicenseLoad | null;
  newestAppliedStartedAt: string | null;
}

export const isedLoadStatusSchema: z.ZodType<IsedLoadStatus> = z.looseObject({
  load: licenseLoadSchema.nullable(),
  newestAppliedStartedAt: z.string().nullable(),
});

export const MAX_ISED_ROWS_PER_REQUEST = 5000;

export interface StatusRequest {
  action: "status";
}

export interface BeginRequest {
  action: "begin";
  version: string;
}

export interface RowsRequest {
  action: "rows";
  load: number;
  rows: IsedRow[];
}

export interface FinishRequest {
  action: "finish";
  load: number;
  rows: number;
}

export interface AbandonRequest {
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
      version: z.string().min(1).max(255).refine((v) => v.trim() !== ""),
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
