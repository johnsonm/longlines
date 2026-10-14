// Turns typed, pasted and CSV text into raw callsign values for the group
// dialog. Nothing here validates or uppercases: every value goes through the
// normalize_group_callsigns RPC, which decides what is a callsign and what is
// stored. Pure, so it is tested in node.

/** Values separated by commas, semicolons or any whitespace (including non-breaking spaces). */
export function splitCallsigns(text: string): string[] {
  return text.split(/[\s,;]+/).filter((v) => v !== "");
}

/**
 * Rows of a CSV file: quoted fields, embedded commas and line breaks, doubled
 * quotes, LF/CRLF/CR endings and a leading byte order mark. A trailing line
 * break doesn't add a row.
 */
export function parseCsv(text: string): string[][] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HEADERS = new Set(["call", "callsign", "call sign", "call_sign"]);

/**
 * The callsign column: the first one headed call, callsign, call sign or
 * call_sign (any case), without its header row; otherwise the first column,
 * every row. Values are trimmed and blanks skipped. `header` is the header as
 * written, or null for the first-column fallback.
 */
export function csvColumn(rows: string[][]): { header: string | null; values: string[] } {
  const first = rows[0] ?? [];
  const index = first.findIndex((h) => HEADERS.has(h.trim().toLowerCase()));
  const header = first[index]?.trim() ?? null;
  const body = index >= 0 ? rows.slice(1) : rows;
  const col = Math.max(index, 0);
  const values = body.map((r) => (r[col] ?? "").trim()).filter((v) => v !== "");
  return { header, values };
}
