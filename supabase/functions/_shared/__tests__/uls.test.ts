import { assertEquals, assertThrows } from "@std/assert";
import { MAX_ULS_RECORD, parseUlsRecord, ulsDate, UlsRecords } from "../uls.ts";

// Synthetic records in the l_amat.zip layout (made-up calls and people; the
// real file's EN rows carry addresses this repository never stores).
const HD =
  "HD|4000001|0009999999||KK4XYS|A|HA|03/14/2019|03/14/2029||||||||||||||||||||N||||||||||||||03/14/2019|03/14/2019|||||||||||||||";
const EN =
  "EN|4000001|||KK4XYS|L|L01234567|Doe, Jane Q|Jane|Q|Doe|Jr|5555550100||jane@example.com|1 Main St|Raleigh|nc|27601||||0001234567|I||||||";
const CLUB =
  "EN|4000002|||W4XYS|L|L07654321|Example Amateur Radio Club||||||||PO Box 1|Cary|NC|27511||||0007654321|B||||||";
const AM = "AM|4000001|||KK4XYS|E|D|4|||||||||||";

Deno.test("parseUlsRecord keeps the HD call sign, status and dates", function (): void {
  assertEquals(parseUlsRecord("HD", HD), {
    usi: 4000001,
    callsign: "KK4XYS",
    status: "Active",
    granted_on: "2019-03-14",
    expires_on: "2029-03-14",
  });
  const expired = parseUlsRecord("HD", "HD|7|||aa6rb|E|HA|11/10/1987|11/10/1997|11/11/1999|");
  assertEquals(expired, {
    usi: 7,
    callsign: "AA6RB",
    status: "Expired",
    granted_on: "1987-11-10",
    expires_on: "1997-11-10",
  });
  assertEquals(parseUlsRecord("HD", "HD|8|||K1ABC|Q|HA|||"), {
    usi: 8,
    callsign: "K1ABC",
    status: "Q",
    granted_on: null,
    expires_on: null,
  });
});

Deno.test("parseUlsRecord keeps only the EN names and state", function (): void {
  assertEquals(parseUlsRecord("EN", EN), {
    usi: 4000001,
    name: "Jane Q Doe Jr",
    first_name: "Jane",
    last_name: "Doe",
    state: "NC",
  });
  // A club has only its entity name.
  assertEquals(parseUlsRecord("EN", CLUB), {
    usi: 4000002,
    name: "Example Amateur Radio Club",
    first_name: null,
    last_name: null,
    state: "NC",
  });
  // Only the last name, odd spacing, a non-state "state".
  assertEquals(parseUlsRecord("EN", "EN|9|||K1ABC|L||DOE,  JOHN|||  DOE ||||||||Xyz|||||"), {
    usi: 9,
    name: "DOE",
    first_name: null,
    last_name: "DOE",
    state: null,
  });
  assertEquals(parseUlsRecord("EN", "EN|9|||K1ABC|L||||||||||||||||"), {
    usi: 9,
    name: null,
    first_name: null,
    last_name: null,
    state: null,
  });
});

Deno.test("parseUlsRecord drops EN entities other than the licensee", function (): void {
  assertEquals(parseUlsRecord("EN", EN.replace("|L|L0", "|CL|L0")), null);
});

Deno.test("parseUlsRecord labels the AM operator class", function (): void {
  assertEquals(parseUlsRecord("AM", AM), { usi: 4000001, operator_class: "Amateur Extra" });
  assertEquals(parseUlsRecord("AM", "AM|5|||W4XYS|||10|AA0AW|"), { usi: 5, operator_class: null });
  assertEquals(parseUlsRecord("AM", "AM|5|||W4XYS|Z|"), { usi: 5, operator_class: "Z" });
});

Deno.test("parseUlsRecord rejects other record types and missing keys", function (): void {
  assertEquals(parseUlsRecord("HD", EN), null);
  assertEquals(parseUlsRecord("HD", "HD||||K1ABC|A|HA|||"), null);
  assertEquals(parseUlsRecord("HD", "HD|1x|||K1ABC|A|HA|||"), null);
  assertEquals(parseUlsRecord("HD", "HD|1|||K1/ABC|A|HA|||"), null);
  assertEquals(parseUlsRecord("HD", "HD|1|||"), null);
  assertEquals(parseUlsRecord("AM", "AM"), null);
});

Deno.test("ulsDate converts mm/dd/yyyy and rejects anything else", function (): void {
  assertEquals(ulsDate("02/29/2024"), "2024-02-29");
  assertEquals(ulsDate(" 12/31/1999 "), "1999-12-31");
  for (const bad of ["02/30/2023", "13/01/2020", "2020-01-01", "", undefined]) {
    assertEquals(ulsDate(bad), null, String(bad));
  }
});

Deno.test("UlsRecords splits CRLF records across chunks and joins broken lines", function (): void {
  const splitter = new UlsRecords("AM");
  // A record is complete only once the next one starts: a broken line may follow.
  assertEquals(splitter.push("AM|1|||A1A|E|\r\nAM|2|||B"), []);
  assertEquals(splitter.push("2B|G|\r\n"), ["AM|1|||A1A|E|"]);
  assertEquals(splitter.push("AM|3|||C3C|T|line\r\nbreak|\r\n\r\nAM|4|||D4D|"), [
    "AM|2|||B2B|G|",
  ]);
  assertEquals(splitter.flush(), ["AM|3|||C3C|T|line break|", "AM|4|||D4D|"]);
  assertEquals(splitter.flush(), []);
});

Deno.test("UlsRecords ignores text before the first record", function (): void {
  const splitter = new UlsRecords("HD");
  assertEquals(splitter.push("junk\r\nHD|1|\r\n"), []);
  assertEquals(splitter.flush(), ["HD|1|"]);
});

Deno.test("UlsRecords throws on a line with no LF past the cap", function (): void {
  const splitter = new UlsRecords("HD");
  assertEquals(splitter.push("HD|1|"), []);
  assertThrows(() => splitter.push("x".repeat(MAX_ULS_RECORD)), Error, "ULS line longer");
});

Deno.test(
  "UlsRecords throws on a record grown past the cap by continuation lines",
  function (): void {
    const splitter = new UlsRecords("EN");
    assertEquals(splitter.push("EN|1|\n"), []);
    const piece = `${"x".repeat(1023)}\n`;
    assertThrows(
      function () {
        for (let i = 0; i < 100; i++) {
          splitter.push(piece);
        }
      },
      Error,
      "ULS record longer",
    );
  },
);

Deno.test("UlsRecords keeps a record at the cap", function (): void {
  const splitter = new UlsRecords("AM");
  const record = `AM|${"x".repeat(MAX_ULS_RECORD - 3)}`;
  assertEquals(splitter.push(`${record}\n`), []);
  assertEquals(splitter.flush(), [record]);
});
