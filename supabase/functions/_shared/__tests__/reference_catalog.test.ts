import { assertEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import {
  catalogFile,
  CsvRecords,
  maidenhead,
  mapCatalogRecord,
  MAX_CSV_RECORD,
  normalizeGrid,
  ReferenceCatalogParser,
  type ReferenceCatalogRow,
  referenceLoadStatusSchema,
  type ReferenceProgram,
  referenceStatusReplySchema,
  sotaDate,
  wwffDate,
} from "../reference_catalog.ts";

// Fixtures cut from the real files on 2026-10-26: the header (and SOTA's title line) plus rows
// picked for their oddities, in file order. POTA's has CRLF line ends, SOTA's and WWFF's LF.
function fixture(name: string): string {
  return Deno.readTextFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

const FIXTURES: Record<ReferenceProgram, string> = {
  pota: fixture("pota-parks.csv"),
  sota: fixture("sota-summits.csv"),
  wwff: fixture("wwff-directory.csv"),
};

const NOW = new Date("2026-10-26T12:00:00Z");

/** Every row of a file, fed in chunks of `size` characters. */
function parse(program: ReferenceProgram, text: string, size: number) {
  const parser = new ReferenceCatalogParser(program, NOW);
  let rows: ReferenceCatalogRow[] = [];
  for (let i = 0; i < text.length; i += size) {
    rows = rows.concat(parser.push(text.slice(i, i + size)));
  }
  rows = rows.concat(parser.flush());
  return { rows, skipped: parser.skipped };
}

function byReference(rows: ReferenceCatalogRow[]): Map<string, ReferenceCatalogRow> {
  return new Map(rows.map((row) => [row.reference, row]));
}

function records(text: string, size: number): string[][] {
  const csv = new CsvRecords("test.csv");
  let out: string[][] = [];
  for (let i = 0; i < text.length; i += size) {
    out = out.concat(csv.push(text.slice(i, i + size)));
  }
  out = out.concat(csv.flush());
  return out;
}

Deno.test("CsvRecords reads RFC 4180 records in chunks of any size", function (): void {
  const text = '﻿a,"b, with comma","c ""quoted"""\r\n' +
    '"multi\r\nline",,"" \n' +
    "\n" +
    'plain"quote,"closed"after,x\r' +
    "last,row";
  const want = [
    ["a", "b, with comma", 'c "quoted"'],
    ["multi\r\nline", "", " "],
    ['plain"quote', "closedafter", "x"],
    ["last", "row"],
  ];
  for (const size of [1, 2, 3, 5, 7, text.length]) {
    assertEquals(records(text, size), want, `chunks of ${String(size)}`);
  }
  // A BOM only counts at the very start, and a trailing line end adds no record.
  assertEquals(records("a\n﻿b\n", 1), [["a"], ["﻿b"]]);
  assertEquals(records("", 1), []);
});

Deno.test("CsvRecords refuses a file that ends inside quotes or a record that never ends", function (): void {
  const csv = new CsvRecords("x.csv");
  csv.push('a,"open');
  assertThrows(() => csv.flush(), ValidationError, "CSV ends inside a quoted field");
  const long = new CsvRecords("x.csv");
  assertThrows(
    () => long.push('"' + "x".repeat(MAX_CSV_RECORD + 1)),
    ValidationError,
    "CSV record longer than",
  );
  // The limit is per record: many short records are fine.
  const many = new CsvRecords("x.csv");
  assertEquals(many.push("ab\n".repeat(MAX_CSV_RECORD)).length, MAX_CSV_RECORD);
});

Deno.test("each fixture parses the same in any chunking", function (): void {
  for (const program of ["pota", "sota", "wwff"] as const) {
    const whole = parse(program, FIXTURES[program], FIXTURES[program].length);
    for (const size of [1, 7, 64, 1000]) {
      assertEquals(parse(program, FIXTURES[program], size), whole, `${program} in ${size}s`);
    }
  }
});

Deno.test("POTA rows map the park list's columns", function (): void {
  const result = parse("pota", FIXTURES.pota, 4096);
  assertEquals([result.rows.length, result.skipped], [22, 0]);
  const rows = byReference(result.rows);
  assertEquals(rows.get("US-0001"), {
    reference: "US-0001",
    name: "Acadia National Park",
    active: true,
    location: "US-ME",
    region: null,
    country: null,
    latitude: 44.31,
    longitude: -68.2034,
    grid: "FN54vh",
    altitude_m: null,
    points: null,
    valid_from: null,
    valid_to: null,
  });
  assertEquals(rows.get("US-0015")!.location, "US-DC,US-MD,US-WV");
  assertEquals(
    rows.get("US-0961")!.name,
    "Salinas Pueblo Missions, Gran Quivira Unit, National Monument",
  );
  assertEquals(rows.get("IT-0177")!.name, 'Bosco del Vaj e "Bosc Grand" Natura 2000');
  assertEquals(
    rows.get("PR-0044")!.name,
    'Parque Nacional Balneario Manuel "Nolo"" Morales" State Park',
  );
  // Inactive, and at 0, 0 (with 0, 0's grid): no coordinates, no grid.
  const station = rows.get("AQ-0025")!;
  assertEquals(
    [station.active, station.latitude, station.longitude, station.grid],
    [false, null, null, null],
  );
  assertEquals(rows.get("PR-0090")!.active, false);
  // No coordinates at all, and a trailing space in the name.
  const ampang = rows.get("MY-0023")!;
  assertEquals([ampang.name, ampang.location, ampang.latitude, ampang.grid], [
    "Taman Rimba Ampang",
    null,
    null,
    null,
  ]);
});

Deno.test("maidenhead matches the grid POTA gives every fixture park", function (): void {
  const parks = parse("pota", FIXTURES.pota, 4096).rows.filter((row) => row.grid !== null);
  assertEquals(parks.length, 19);
  for (const park of parks) {
    assertEquals(maidenhead(park.latitude!, park.longitude!), park.grid, park.reference);
  }
  assertEquals(maidenhead(-90, -180), "AA00aa");
  assertEquals(maidenhead(90, 180), "RR99xx");
});

Deno.test("SOTA rows skip the title line and derive the grid", function (): void {
  const result = parse("sota", FIXTURES.sota, 4096);
  assertEquals([result.rows.length, result.skipped], [16, 0]);
  const rows = byReference(result.rows);
  assertEquals(rows.get("W4C/CM-001"), {
    reference: "W4C/CM-001",
    name: "Mount Mitchell",
    active: true,
    location: null,
    region: "USA - Carolinas, NC-Central Mountains",
    country: null,
    latitude: 35.7648,
    longitude: -82.2652,
    grid: "EM85us",
    altitude_m: 2037,
    points: 10,
    valid_from: "2011-02-01",
    valid_to: "2099-12-31",
  });
  assertEquals(rows.get("G/LD-001")!.grid, "IO84jk");
  assertEquals(rows.get("9M6/KB-001")!.name, "Kinabalu, Lows Peak");
  assertEquals(rows.get("W7N/CK-287")!.name, '""Pasture Mountain""');
  assertEquals(
    rows.get("3B8/MU-001")!.name,
    "Piton de la Petite Rivière Noire (Black River Peak)",
  );
  // Retired: ValidTo in the past. A summit not valid yet still counts as active.
  for (const retired of ["C3/AD-004", "CT/BA-002", "W4C/CM-002"]) {
    assertEquals(rows.get(retired)!.active, false, retired);
  }
  assertEquals(rows.get("CT/BA-002")!.valid_to, "2023-03-31");
  assertEquals(
    [rows.get("W1/AM-434")!.active, rows.get("W1/AM-434")!.valid_from],
    [true, "2027-02-01"],
  );
});

Deno.test("SOTA's active follows the clock: ValidTo is the last valid day", function (): void {
  const header = new Map([["SummitCode", 0], ["ValidTo", 1]]);
  function active(now: string): boolean {
    const result = mapCatalogRecord("sota", header, ["X/YY-001", "31/12/2025"], new Date(now));
    return result.kind === "row" && result.row.active;
  }
  assertEquals(active("2025-12-31T23:59:59Z"), true);
  assertEquals(active("2026-01-01T00:00:00Z"), false);
});

Deno.test("WWFF rows map the directory's columns and skip its repeated header", function (): void {
  const result = parse("wwff", FIXTURES.wwff, 4096);
  // The directory repeats its header partway down; that row is the one skip.
  assertEquals([result.rows.length, result.skipped], [21, 1]);
  const rows = byReference(result.rows);
  assertEquals(rows.get("KFF-6101"), {
    reference: "KFF-6101",
    name: "State Game Land PA 013",
    active: true,
    location: null,
    region: "K-PA",
    country: null,
    latitude: 41.315,
    longitude: -76.3491,
    grid: "FN11th",
    altitude_m: null,
    points: null,
    valid_from: "2022-11-02",
    valid_to: null,
  });
  // The state when there is one, else the region; the country when the directory names one.
  assertEquals(rows.get("SMFF-0001")!.region, "Laen BD");
  assertEquals(rows.get("VEFF-0001")!.region, "VE-BC");
  assertEquals(rows.get("1SFF-0001")!.country, "Spratly Archipelago");
  assertEquals(rows.get("3AFF-0001")!.country, "Monaco");
  // Deleted and national references are not active; deletions carry their date.
  const deleted = rows.get("9AFF-0078")!;
  assertEquals(
    [deleted.active, deleted.valid_from, deleted.valid_to, deleted.latitude, deleted.grid],
    [false, null, "2017-12-25", null, null],
  );
  assertEquals(rows.get("OEFF-0047")!.active, false);
  // Locators: padded, prefixed with -, a region code, 0, 0's square, none.
  assertEquals(rows.get("4XFF-0211")!.grid, "KM71ks");
  assertEquals(rows.get("8RFF-0002")!.grid, "GJ01pn");
  assertEquals(rows.get("EAFF-0398")!.grid, null);
  assertEquals(rows.get("ANFF-0002")!.grid, null);
  assertEquals(rows.get("DLFF-1365")!.grid, null);
  assertEquals(rows.get("DLFF-1365")!.name, 'LSG "Regnitzgrund"');
  assertEquals(
    rows.get("4JFF-0016")!.name,
    "Yanar Dagh State Historical, Cultural and Natural Reserve",
  );
  // A record with a line break inside a quoted field, and a lower-case reference.
  assertEquals(rows.get("ESFF-0265")!.name, "Tahkuna");
  assertEquals(rows.get("SELECT-0001")!.name, "Special Takahe Area");
});

Deno.test("a file without its header is refused", function (): void {
  const parser = new ReferenceCatalogParser("wwff", NOW);
  assertEquals(parser.push("reference,status,name\nKFF-0001,active,Park\n"), []);
  assertThrows(() => parser.flush(), ValidationError, "wwff_directory.csv has no header with");
  const late = new ReferenceCatalogParser("sota", NOW);
  assertThrows(
    () => late.push("title\n".repeat(6) + FIXTURES.sota),
    ValidationError,
    "summitslist.csv has no header",
  );
  assertThrows(() => new ReferenceCatalogParser("pota", NOW).flush(), ValidationError, "no header");
  assertEquals(catalogFile("pota"), "all_parks_ext.csv");
});

Deno.test("references, grids and dates are checked before they are kept", function (): void {
  const header = new Map([["reference", 0], ["active", 1], ["latitude", 2], ["longitude", 3], [
    "grid",
    4,
  ]]);
  function map(record: string[]) {
    return mapCatalogRecord("pota", header, record, NOW);
  }
  for (const bad of ["", "-", "US", "US-", "US 0001", "US-0001;", `US-${"1".repeat(62)}`]) {
    assertEquals(map([bad, "1"]), { kind: "skip" }, bad);
  }
  const lower = map([" us-0001 ", "1", "91", "0", "FN54vh"]);
  assertEquals(lower.kind === "row" && [lower.row.reference, lower.row.latitude], [
    "US-0001",
    null,
  ]);
  // A record shorter than its header reads the missing fields as absent.
  const short = map(["US-0002"]);
  assertEquals(short.kind === "row" && [short.row.active, short.row.grid], [false, null]);

  assertEquals(normalizeGrid("fn54"), "FN54");
  assertEquals(normalizeGrid("FN54VH"), "FN54vh");
  for (const bad of [undefined, "", "-", "R1", "FN5", "SZ00aa", "FN54vz", "JJ00AA", "JJ00"]) {
    assertEquals(normalizeGrid(bad), null, bad);
  }
  assertEquals(sotaDate("29/02/2024"), "2024-02-29");
  for (const bad of [undefined, "", "29/02/2023", "2024-02-29", "1/2/2024"]) {
    assertEquals(sotaDate(bad), null, bad);
  }
  assertEquals(wwffDate("2017-12-25"), "2017-12-25");
  for (const bad of [undefined, "0000-00-00", "2017-13-01", "25/12/2017"]) {
    assertEquals(wwffDate(bad), null, bad);
  }
});

Deno.test("SOTA altitude and points take integers only", function (): void {
  const header = new Map([["SummitCode", 0], ["AltM", 1], ["Points", 2]]);
  const result = mapCatalogRecord("sota", header, ["X/YY-001", "12.5", "99999999999"], NOW);
  assertEquals(result.kind === "row" && [result.row.altitude_m, result.row.points], [null, null]);
});

Deno.test("referenceLoadStatusSchema reads reference_load_status' jsonb", function (): void {
  const status = {
    pota: {
      applied: {
        version: "Mon, 19 Oct 2026 07:15:20 GMT",
        applied_at: "2026-10-19T08:55:00Z",
        rows: 99000,
      },
      newest: {
        id: 4,
        version: "Mon, 26 Oct 2026 07:15:20 GMT",
        state: "refused",
        rows: 120,
        started_at: "2026-10-26T08:00:00Z",
        finished_at: "2026-10-26T08:01:00Z",
        error: "too few rows",
      },
    },
    sota: { applied: null, newest: null },
    wwff: { applied: null, newest: null },
  };
  assertEquals(referenceLoadStatusSchema.safeParse(status).success, true);
  assertEquals(referenceStatusReplySchema.safeParse({ status }).success, true);
  assertEquals(referenceStatusReplySchema.safeParse({ status, extra: 1 }).success, false);
  assertEquals(
    referenceLoadStatusSchema.safeParse({ pota: status.pota, sota: status.sota }).success,
    false,
  );
});
