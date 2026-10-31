// Innovation, Science and Economic Development Canada (ISED) special callsign records
// (special_callsign.zip / special_callsign.txt).
//
// Header: Special_call_sign;beg_date;end_date;event_en;event_fr;call_sign_request;use_by

import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { CANADIAN_CALLSIGN } from "./ised.ts";

const CALLSIGN = new RegExp(CANADIAN_CALLSIGN.source + "|^[A-Z]{2}$");

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
  beg_date: z.string(),
  end_date: z.string(),
  event_en: z.string().nullable(),
  event_fr: z.string().nullable(),
  call_sign_request: z.string().nullable(),
  use_by: z.string().nullable(),
});

export const MAX_SPECIAL_RECORD = 64 * 1024;

export class IsedSpecialRecords {
  #partial = "";
  #header: string[] | null = null;
  #skipped = 0;
  readonly #where = "IsedSpecialRecords: special_callsign.txt";

  get skipped(): number {
    return this.#skipped;
  }

  push(chunk: string): IsedSpecialRow[] {
    const lines = (this.#partial + chunk).split(/\r?\n/);
    const last = lines.pop();
    if (last === undefined) {
      this.#partial = "";
    } else {
      this.#partial = last;
    }
    if (this.#partial.length > MAX_SPECIAL_RECORD) {
      throw new ValidationError(
        `ISED special callsign line longer than ${String(MAX_SPECIAL_RECORD)} characters`,
        {
          cause: undefined,
          where: this.#where,
        },
      );
    }

    const rows: IsedSpecialRow[] = [];
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
          "special_call_sign",
          "beg_date",
          "end_date",
          "event_en",
          "event_fr",
          "call_sign_request",
          "use_by",
        ];
        for (const req of required) {
          if (!this.#header.includes(req)) {
            throw new ValidationError(`ISED special header missing required column: ${req}`, {
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

      const callVal = map.get("special_call_sign");
      let callsign = "";
      if (callVal !== undefined) {
        callsign = callVal.trim().toUpperCase();
      }
      if (!CALLSIGN.test(callsign)) {
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
      const eventEn = cleanText(map.get("event_en"));
      const eventFr = cleanText(map.get("event_fr"));
      const reqCall = cleanText(map.get("call_sign_request"));
      const useBy = cleanText(map.get("use_by"));

      rows.push({
        callsign,
        beg_date: begDate,
        end_date: endDate,
        event_en: eventEn,
        event_fr: eventFr,
        call_sign_request: reqCall,
        use_by: useBy,
      });
    }
    return rows;
  }
}
