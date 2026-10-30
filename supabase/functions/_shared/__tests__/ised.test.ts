import { assertEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { CANADIAN_CALLSIGN, IsedRecords, type IsedRow, MAX_ISED_RECORD } from "../ised.ts";

const FIXTURE_URL = new URL("./fixtures/ised-amateur.txt", import.meta.url);

Deno.test(
  "IsedRecords parses fixture correctly, preserves literal quotes, and strips address fields",
  async function () {
    const text = await Deno.readTextFile(FIXTURE_URL);
    const records = new IsedRecords();
    const rows = records.push(text).concat(records.flush());

    assertEquals(rows.length, 7);
    // Skipped: BADCALL, C|1A, V|3ABC, VE3BADQUAL, VE3WRONGCOL, VE3SHORT, VE3EXTRA
    assertEquals(records.skipped, 7);

    const helene = rows.find((r) => r.callsign === "VE3TSS");
    assertEquals(helene, {
      callsign: "VE3TSS",
      first_name: "Hélène",
      last_name: "McFadden",
      club_name: null,
      province: "ON",
      qualifications: "ACD",
    });

    // Literal quotes in names are preserved (file has no quoting).
    const frank = rows.find((r) => r.callsign === "VA7QSS");
    assertEquals(frank, {
      callsign: "VA7QSS",
      first_name: "Françoise",
      last_name: '"Frank"',
      club_name: null,
      province: "BC",
      qualifications: "A",
    });

    // Padded names trimmed.
    const david = rows.find((r) => r.callsign === "VE1CSS");
    assertEquals(david, {
      callsign: "VE1CSS",
      first_name: "DAVID",
      last_name: "LEWIS",
      club_name: null,
      province: "NS",
      qualifications: "DE",
    });

    // Blank name and blank province become null; E-only qualification.
    const blankProv = rows.find((r) => r.callsign === "VE6ESS");
    assertEquals(blankProv, {
      callsign: "VE6ESS",
      first_name: null,
      last_name: null,
      club_name: null,
      province: null,
      qualifications: "E",
    });

    // Club joins club_name + club_name_2 and keeps person fields (SQL drops trustee names).
    const club = rows.find((r) => r.callsign === "VE5CSS");
    assertEquals(club, {
      callsign: "VE5CSS",
      first_name: "Trustee",
      last_name: "Person",
      club_name: "Example Radio Club HQ",
      province: "SK",
      qualifications: "A",
    });

    // Privacy: exact 6-key set, zero address/city/postal fields.
    for (const row of rows) {
      assertEquals(
        Object.keys(row).sort(),
        ["callsign", "club_name", "first_name", "last_name", "province", "qualifications"].sort(),
      );
    }
  },
);

Deno.test("CANADIAN_CALLSIGN rejects pipe literals and invalid prefixes", function () {
  assertEquals(CANADIAN_CALLSIGN.test("C|1A"), false);
  assertEquals(CANADIAN_CALLSIGN.test("V|3ABC"), false);
  assertEquals(CANADIAN_CALLSIGN.test("VE3TSS"), true);
  assertEquals(CANADIAN_CALLSIGN.test("CY0S"), true);
  assertEquals(CANADIAN_CALLSIGN.test("XM3A"), true);
});

Deno.test(
  "IsedRecords reads header by name (shuffled columns) and rejects missing required columns",
  async function () {
    const text = await Deno.readTextFile(FIXTURE_URL);
    const base = new IsedRecords();
    const baseRows = base.push(text).concat(base.flush());

    // Reverse every column on every line.
    const reversedLines: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      if (rawLine === "") {
        continue;
      }
      reversedLines.push(rawLine.split(";").reverse().join(";"));
    }
    const shuffled = new IsedRecords();
    const shuffledRows = shuffled.push(reversedLines.join("\r\n") + "\r\n").concat(
      shuffled.flush(),
    );
    assertEquals(shuffledRows, baseRows);
    assertEquals(shuffled.skipped, base.skipped);

    // Missing required column throws ValidationError.
    const bad = new IsedRecords();
    assertThrows(
      function () {
        bad.push("callsign;first_name;surname;prov_cd\r\n");
      },
      ValidationError,
      "missing required column",
    );
  },
);

Deno.test(
  "IsedRecords streams in 7-byte chunks and flushes an unterminated final line",
  async function () {
    const bytes = await Deno.readFile(FIXTURE_URL);
    const baseline = new IsedRecords();
    const text = new TextDecoder().decode(bytes);
    const expected = baseline.push(text).concat(baseline.flush());

    const streamed = new IsedRecords();
    const decoder = new TextDecoder();
    const got: IsedRow[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      const chunk = decoder.decode(bytes.subarray(i, i + 7), { stream: true });
      for (const row of streamed.push(chunk)) {
        got.push(row);
      }
    }
    const finalChunk = decoder.decode();
    for (const row of streamed.push(finalChunk)) {
      got.push(row);
    }
    for (const row of streamed.flush()) {
      got.push(row);
    }
    assertEquals(got, expected);
    assertEquals(streamed.skipped, baseline.skipped);

    // Unterminated final line is emitted by flush().
    const noEol = new IsedRecords();
    const header =
      "callsign;first_name;surname;address_line;city;prov_cd;postal_code;qual_a;qual_b;qual_c;qual_d;qual_e;club_name;club_name_2;club_address;club_city;club_prov_cd;club_postal_code\r\n";
    assertEquals(noEol.push(header), []);
    assertEquals(noEol.push("VE3TSS;John;Smith;123 St;Ottawa;ON;K1A0B1;A;;;;;;;;;;"), []);
    const flushed = noEol.flush();
    assertEquals(flushed.length, 1);
    assertEquals(flushed[0]!.callsign, "VE3TSS");
  },
);

Deno.test("IsedRecords rejects lines exceeding MAX_ISED_RECORD", function () {
  const records = new IsedRecords();
  assertThrows(
    function () {
      records.push("A".repeat(MAX_ISED_RECORD + 1));
    },
    ValidationError,
    "longer than",
  );
});
