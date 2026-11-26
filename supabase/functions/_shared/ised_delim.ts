// Streaming reader for ISED's semicolon-delimited, unquoted text files
// (amateur_delim.txt and special_callsign.txt).
//
// Splits CRLF/LF lines across arbitrary chunks, reads the header row by column
// name (lowercased), validates required columns, skips lines whose field count
// disagrees with the header, and guards against unbounded lines.

import { ValidationError } from "./errors.ts";

export const MAX_ISED_RECORD = 64 * 1024;

/** Trims a field and turns blank text into null. Literal quotes are preserved. */
export function cleanIsedText(val: string | undefined): string | null {
  if (val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed;
}

export class IsedDelimReader {
  #partial = "";
  #header: string[] | null = null;
  #skipped = 0;
  readonly #where: string;
  readonly #requiredColumns: readonly string[];

  constructor(where: string, requiredColumns: readonly string[]) {
    this.#where = where;
    this.#requiredColumns = requiredColumns;
  }

  get skipped(): number {
    return this.#skipped;
  }

  /** Records completed by this chunk, keyed by lowercased header column name. */
  push(chunk: string): Map<string, string>[] {
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
    return this.#take(lines);
  }

  /** Any unterminated final line left at EOF. */
  flush(): Map<string, string>[] {
    const tail = this.#partial;
    this.#partial = "";
    if (tail === "") {
      return [];
    }
    return this.#take([tail]);
  }

  #take(lines: string[]): Map<string, string>[] {
    const out: Map<string, string>[] = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line.trim() === "") {
        continue;
      }
      if (line.length > MAX_ISED_RECORD) {
        throw new ValidationError(`ISED line longer than ${String(MAX_ISED_RECORD)} characters`, {
          cause: undefined,
          where: this.#where,
        });
      }
      const fields = line.split(";");

      if (this.#header === null) {
        this.#header = fields.map((f) => f.trim().toLowerCase());
        for (const req of this.#requiredColumns) {
          if (!this.#header.includes(req)) {
            throw new ValidationError(`ISED header missing required column: ${req}`, {
              cause: undefined,
              where: this.#where,
            });
          }
        }
        continue;
      }

      if (fields.length !== this.#header.length) {
        this.#skipped++;
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
      out.push(map);
    }
    return out;
  }
}
