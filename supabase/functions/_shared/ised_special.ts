// Innovation, Science and Economic Development Canada (ISED) special callsign records
// (special_callsign.zip / special_callsign.txt), parsed into rows load-ised-special stages.
//
// Header: Special_call_sign;beg_date;end_date;event_en;event_fr;call_sign_request;use_by

import { z } from "zod";
import { CANADIAN_CALLSIGN, MAX_ISED_ROWS_PER_REQUEST } from "./ised.ts";
import { cleanIsedText, IsedDelimReader, MAX_ISED_RECORD } from "./ised_delim.ts";

// Special event prefixes (two characters, e.g. CI, CG, CF, CH) are special event prefixes, not call signs,
// and are not yet supported.
// See: https://ised-isde.canada.ca/site/spectrum-management-telecommunications/en/licences-and-certificates/radiocom-information-circulars-ric/ric-9-call-sign-policy-and-special-event-prefixes#table1

const isoDateSchema = z.iso.date();

export interface IsedSpecialRow {
  callsign: string;
  beg_date: string;
  end_date: string;
  event_en: string | null;
  event_fr: string | null;
  call_sign_request: string | null;
  use_by: string | null;
}

export const isedSpecialRowSchema: z.ZodType<IsedSpecialRow> = z.strictObject({
  callsign: z.string().min(1).max(32),
  beg_date: isoDateSchema,
  end_date: isoDateSchema,
  event_en: z.string().nullable(),
  event_fr: z.string().nullable(),
  call_sign_request: z.string().nullable(),
  use_by: z.string().nullable(),
});

export const MAX_SPECIAL_RECORD = MAX_ISED_RECORD;

const REQUIRED_COLUMNS = [
  "special_call_sign",
  "beg_date",
  "end_date",
  "event_en",
  "event_fr",
  "call_sign_request",
  "use_by",
];

function isValidIsoDate(value: string): boolean {
  return isoDateSchema.safeParse(value).success;
}

export class IsedSpecialRecords {
  readonly #reader = new IsedDelimReader(
    "IsedSpecialRecords: special_callsign.txt",
    REQUIRED_COLUMNS,
  );
  #skipped = 0;

  get skipped(): number {
    return this.#reader.skipped + this.#skipped;
  }

  push(chunk: string): IsedSpecialRow[] {
    return this.#parse(this.#reader.push(chunk));
  }

  flush(): IsedSpecialRow[] {
    return this.#parse(this.#reader.flush());
  }

  #parse(maps: Map<string, string>[]): IsedSpecialRow[] {
    const rows: IsedSpecialRow[] = [];
    for (const map of maps) {
      const callVal = map.get("special_call_sign");
      let callsign = "";
      if (callVal !== undefined) {
        callsign = callVal.trim().toUpperCase();
      }
      if (!CANADIAN_CALLSIGN.test(callsign)) {
        this.#skipped++;
        continue;
      }

      const begDateVal = map.get("beg_date");
      let begDate = "";
      if (begDateVal !== undefined) {
        begDate = begDateVal.trim();
      }
      const endDateVal = map.get("end_date");
      let endDate = "";
      if (endDateVal !== undefined) {
        endDate = endDateVal.trim();
      }
      if (!isValidIsoDate(begDate) || !isValidIsoDate(endDate)) {
        this.#skipped++;
        continue;
      }

      rows.push({
        callsign,
        beg_date: begDate,
        end_date: endDate,
        event_en: cleanIsedText(map.get("event_en")),
        event_fr: cleanIsedText(map.get("event_fr")),
        call_sign_request: cleanIsedText(map.get("call_sign_request")),
        use_by: cleanIsedText(map.get("use_by")),
      });
    }
    return rows;
  }
}

export interface SpecialStatusRequest {
  action: "status";
}

export interface SpecialBeginRequest {
  action: "begin";
  version: string;
}

export interface SpecialRowsRequest {
  action: "rows";
  load: number;
  rows: IsedSpecialRow[];
}

export interface SpecialFinishRequest {
  action: "finish";
  load: number;
  rows: number;
}

export interface SpecialAbandonRequest {
  action: "abandon";
  load: number;
  error: string;
}

export type LoadIsedSpecialRequest =
  | SpecialStatusRequest
  | SpecialBeginRequest
  | SpecialRowsRequest
  | SpecialFinishRequest
  | SpecialAbandonRequest;

export const loadIsedSpecialRequestSchema: z.ZodType<LoadIsedSpecialRequest> = z
  .discriminatedUnion("action", [
    z.strictObject({ action: z.literal("status") }),
    z.strictObject({
      action: z.literal("begin"),
      version: z.string().min(1).max(255).refine((v) => v.trim() !== ""),
    }),
    z.strictObject({
      action: z.literal("rows"),
      load: z.number().int().min(1),
      rows: z.array(isedSpecialRowSchema).min(1).max(MAX_ISED_ROWS_PER_REQUEST),
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
