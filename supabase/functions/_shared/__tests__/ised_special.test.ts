import { assertEquals } from "@std/assert";
import { IsedSpecialRecords } from "../ised_special.ts";

Deno.test("IsedSpecialRecords parses fixture correctly", async function () {
  const text = await Deno.readTextFile(new URL("./fixtures/ised-special.txt", import.meta.url));
  const records = new IsedSpecialRecords();
  const rows = records.push(text);

  assertEquals(rows.length, 3);
  assertEquals(records.skipped, 1);

  const ci = rows.find(function (r) {
    return r.callsign === "CI";
  });
  assertEquals(ci, {
    callsign: "CI",
    beg_date: "2005-05-01",
    end_date: "2005-05-31",
    event_en: "Grand opening of the Canadian War Museum",
    event_fr: "Grande Ouverture du Musée Canadien de la Guerre",
    call_sign_request: null,
    use_by: "VY",
  });

  const cf = rows.find(function (r) {
    return r.callsign === "CF3VEDAY";
  });
  assertEquals(cf, {
    callsign: "CF3VEDAY",
    beg_date: "2005-05-01",
    end_date: "2005-05-31",
    event_en: "Grand opening of the Canadian War Museum",
    event_fr: "Grande Ouverture du Musée Canadien de la Guerre",
    call_sign_request: null,
    use_by: "VA3ROR",
  });
});
