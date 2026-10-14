import { describe, expect, it } from "vitest";
import { csvColumn, parseCsv, splitCallsigns } from "./parse";

describe("splitCallsigns", () => {
  it("splits on commas, whitespace, semicolons and new lines", () => {
    expect(splitCallsigns("KK4PWJ, n4dxx;AB4RD\nKN4QHW\r\nW4KNX\tKO4YUF  N4CPA")).toEqual([
      "KK4PWJ", "n4dxx", "AB4RD", "KN4QHW", "W4KNX", "KO4YUF", "N4CPA",
    ]);
  });

  it("splits on non-breaking spaces and drops blanks", () => {
    expect(splitCallsigns(" ,, KK4PWJ N4DXX ;\n\n")).toEqual(["KK4PWJ", "N4DXX"]);
    expect(splitCallsigns("   ")).toEqual([]);
  });

  it("leaves validation to the server", () => {
    expect(splitCallsigns("KK4PWJ/P not-a-call 12345")).toEqual(["KK4PWJ/P", "not-a-call", "12345"]);
  });
});

describe("parseCsv", () => {
  it("parses plain rows with LF, CRLF and CR endings", () => {
    expect(parseCsv("a,b\nc,d\r\ne,f\rg,h")).toEqual([["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]]);
  });

  it("ignores a trailing line break", () => {
    expect(parseCsv("a,b\r\n")).toEqual([["a", "b"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("strips a byte order mark", () => {
    expect(parseCsv("﻿Call,Name\nKK4PWJ,Brad")).toEqual([["Call", "Name"], ["KK4PWJ", "Brad"]]);
  });

  it("handles quoted fields, embedded commas, doubled quotes and line breaks", () => {
    expect(parseCsv('"KK4PWJ","Bazemore, Brad","say ""hi"""\n"N4DXX","two\nlines",x')).toEqual([
      ["KK4PWJ", "Bazemore, Brad", 'say "hi"'],
      ["N4DXX", "two\nlines", "x"],
    ]);
  });

  it("keeps empty fields", () => {
    expect(parseCsv(",KK4PWJ,\n\"\",x,")).toEqual([["", "KK4PWJ", ""], ["", "x", ""]]);
  });

  it("keeps blank lines as one empty field", () => {
    expect(parseCsv("a\n\nb")).toEqual([["a"], [""], ["b"]]);
  });
});

describe("csvColumn", () => {
  it.each(["call", "Callsign", "CALL SIGN", " call_sign "])("uses the column headed %s", (header) => {
    const rows = [["Name", header, "Club"], ["Brad", "KK4PWJ", "RARS"], ["Ann", "n4dxx", "RARS"]];
    expect(csvColumn(rows)).toEqual({ header: header.trim(), values: ["KK4PWJ", "n4dxx"] });
  });

  it("uses the first matching header when there are several", () => {
    expect(csvColumn([["Callsign", "Call"], ["A1A", "B1B"]])).toEqual({ header: "Callsign", values: ["A1A"] });
  });

  it("falls back to the first column, header row included", () => {
    expect(csvColumn([["Name", "Club"], ["KK4PWJ", "RARS"], ["N4DXX"]])).toEqual({
      header: null, values: ["Name", "KK4PWJ", "N4DXX"],
    });
  });

  it("trims cells and skips blank and missing ones", () => {
    expect(csvColumn([["Club", "Call"], ["RARS", " KK4PWJ "], ["RARS", ""], ["RARS"], ["", "N4DXX"]])).toEqual({
      header: "Call", values: ["KK4PWJ", "N4DXX"],
    });
  });

  it("finds nothing in an empty file", () => {
    expect(csvColumn([])).toEqual({ header: null, values: [] });
    expect(csvColumn([["Callsign"]])).toEqual({ header: "Callsign", values: [] });
  });
});
