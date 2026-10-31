import { assertEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../errors.ts";
import { IsedSpecialRecords, type IsedSpecialRow, isedSpecialRowSchema } from "../ised_special.ts";

const FIXTURE_URL = new URL("./fixtures/ised-special.txt", import.meta.url);

Deno.test(
  "IsedSpecialRecords parses valid rows and skips 2-char prefixes, bad calls, bad dates, and short lines",
  async function () {
    const text = await Deno.readTextFile(FIXTURE_URL);
    const records = new IsedSpecialRecords();
    const rows = records.push(text).concat(records.flush());

    assertEquals(rows.length, 2);
    // Skipped: CI, BADCALL, VE3NODATE, VE3DMY, VE3FEB31, VE3SHORT
    assertEquals(records.skipped, 6);

    const cf = rows.find((r) => r.callsign === "CF3VEDAY");
    assertEquals(cf, {
      callsign: "CF3VEDAY",
      beg_date: "2005-05-01",
      end_date: "2005-05-31",
      event_en: "Grand opening of the Canadian War Museum",
      event_fr: "Grande Ouverture du Musée Canadien de la Guerre",
      call_sign_request: null,
      use_by: "VA3ROR",
    });

    const vd = rows.find((r) => r.callsign === "VD2X");
    assertEquals(vd, {
      callsign: "VD2X",
      beg_date: "2005-06-15",
      end_date: "2005-07-15",
      event_en: "Commemoration of the 100th Anniversary",
      event_fr: "Pour commémorer le centenaire",
      call_sign_request: "VA3RA",
      use_by: null,
    });
  },
);

Deno.test(
  "IsedSpecialRecords streams in 7-byte chunks and rejects missing required columns",
  async function () {
    const bytes = await Deno.readFile(FIXTURE_URL);
    const baseline = new IsedSpecialRecords();
    const expected = baseline.push(new TextDecoder().decode(bytes)).concat(baseline.flush());

    const streamed = new IsedSpecialRecords();
    const decoder = new TextDecoder();
    const got: IsedSpecialRow[] = [];
    for (let i = 0; i < bytes.length; i += 7) {
      const chunk = decoder.decode(bytes.subarray(i, i + 7), { stream: true });
      for (const row of streamed.push(chunk)) {
        got.push(row);
      }
    }
    for (const row of streamed.push(decoder.decode())) {
      got.push(row);
    }
    for (const row of streamed.flush()) {
      got.push(row);
    }
    assertEquals(got, expected);
    assertEquals(streamed.skipped, baseline.skipped);

    const bad = new IsedSpecialRecords();
    assertThrows(
      function () {
        bad.push("Special_call_sign;beg_date;end_date\r\n");
      },
      ValidationError,
      "missing required column",
    );
  },
);

Deno.test(
  "isedSpecialRowSchema rejects blank, non-ISO, and impossible calendar dates",
  function () {
    const base = {
      callsign: "CF3VEDAY",
      beg_date: "2005-05-01",
      end_date: "2005-05-31",
      event_en: "Event",
      event_fr: null,
      call_sign_request: null,
      use_by: "VA3ROR",
    };
    assertEquals(isedSpecialRowSchema.safeParse(base).success, true);
    assertEquals(
      isedSpecialRowSchema.safeParse({
        callsign: base.callsign,
        beg_date: "",
        end_date: base.end_date,
        event_en: base.event_en,
        event_fr: base.event_fr,
        call_sign_request: base.call_sign_request,
        use_by: base.use_by,
      }).success,
      false,
    );
    assertEquals(
      isedSpecialRowSchema.safeParse({
        callsign: base.callsign,
        beg_date: "01/05/2005",
        end_date: base.end_date,
        event_en: base.event_en,
        event_fr: base.event_fr,
        call_sign_request: base.call_sign_request,
        use_by: base.use_by,
      }).success,
      false,
    );
    assertEquals(
      isedSpecialRowSchema.safeParse({
        callsign: base.callsign,
        beg_date: base.beg_date,
        end_date: "2026-02-31",
        event_en: base.event_en,
        event_fr: base.event_fr,
        call_sign_request: base.call_sign_request,
        use_by: base.use_by,
      }).success,
      false,
    );
  },
);
