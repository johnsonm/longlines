import { assertEquals } from "@std/assert";
import { IsedRecords } from "../ised.ts";

Deno.test("IsedRecords parses fixture correctly and strips address fields", async function () {
  const text = await Deno.readTextFile(new URL("./fixtures/ised-amateur.txt", import.meta.url));
  const records = new IsedRecords();
  const rows = records.push(text);

  assertEquals(rows.length, 7);
  assertEquals(records.skipped, 3);

  const helene = rows.find(function (r) {
    return r.callsign === "VE3TSS";
  });
  assertEquals(helene, {
    callsign: "VE3TSS",
    first_name: "Hélène",
    last_name: "McFadden",
    club_name: null,
    province: "ON",
    qualifications: "ACD",
  });

  const frank = rows.find(function (r) {
    return r.callsign === "VA7QSS";
  });
  assertEquals(frank, {
    callsign: "VA7QSS",
    first_name: "Françoise",
    last_name: "Frank",
    club_name: null,
    province: "BC",
    qualifications: "A",
  });

  for (const row of rows) {
    assertEquals(
      Object.keys(row).sort(),
      ["callsign", "club_name", "first_name", "last_name", "province", "qualifications"].sort(),
    );
  }

  const club = rows.find(function (r) {
    return r.callsign === "VE5CSS";
  });
  if (club !== undefined) {
    assertEquals(club.club_name, "Example Radio Club HQ");
  }
});

Deno.test("IsedRecords streams chunks correctly", function () {
  const records = new IsedRecords();
  const chunk1 =
    "callsign;first_name;surname;address_line;city;prov_cd;postal_code;qual_a;qual_b;qual_c;qual_d;qual_e;club_name;club_name_2;club_address;club_city;club_prov_cd;club_postal_code\r\n";
  const chunk2 = "VE3TSS;John;Smith;123 St;Ottawa;ON;K1A0B1;A;;;;;;;;;;\r\n";

  const r1 = records.push(chunk1);
  assertEquals(r1, []);
  const r2 = records.push(chunk2);
  assertEquals(r2.length, 1);
});
