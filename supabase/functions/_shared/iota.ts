// IOTA (Islands on the Air): the reference in a DX Cluster comment, and the
// list of groups that names it. Spec: docs/superpowers/specs/2026-10-27-iota-design.md.
//
// IOTA has no spot feed; activators are spotted on the DX Cluster with the
// reference in the comment ("CQ from Arctowski (AN-010)-UP"). As in Spothole,
// a reference is a continent code, a dash and three digits anywhere in the
// comment between non-word characters, with or without "IOTA" before it.
//
// The list is iota-world.org's groups.json, a JSON array of the groups:
//   refno  string  "EU-005"
//   name   string  "Great Britain"
// and fields we do not keep (bounding box, DXCC, credit percentage).

import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { fetchJson } from "./http.ts";
import { requiredTextSchema } from "./normalize.ts";
import { parseWith } from "./validate.ts";

export const IOTA_GROUPS_URL =
  "https://www.iota-world.org/islands-on-the-air/downloads/download-file.html?path=groups.json";

/** About 1,200 groups; fewer than this means a truncated or wrong file. */
export const MIN_IOTA_GROUPS = 1000;

// Only the dash form: "EU005" and "EU 005" are left out, as Spothole does, to keep false matches out.
const REFERENCE = /(?<![A-Za-z0-9_])(AF|AN|AS|EU|NA|OC|SA)-(\d{3})(?![A-Za-z0-9_])/i;
const REFNO = /^(AF|AN|AS|EU|NA|OC|SA)-\d{3}$/;

/** The first IOTA reference in a comment, uppercased, or null when it names none. */
export function iotaReference(comment: string): string | null {
  const m = REFERENCE.exec(comment);
  if (m === null) {
    return null;
  }
  return `${String(m[1]).toUpperCase()}-${String(m[2])}`;
}

/** One group as load_iota_groups takes it. */
export interface IotaGroup {
  refno: string;
  name: string;
}

// Third-party data: loose, since groups.json carries more fields than these.
const iotaGroupSchema: z.ZodType<IotaGroup> = z.looseObject({
  refno: z.string().transform((value) => value.trim().toUpperCase()).pipe(
    z.string().regex(REFNO, "not an IOTA reference"),
  ),
  name: requiredTextSchema.transform((value) => value.trim()),
});

const iotaGroupsSchema: z.ZodType<IotaGroup[]> = z.array(iotaGroupSchema);

/**
 * The groups in the file, refno and name only. Throws ValidationError when the
 * body is not a list of groups, a row is malformed, or a reference repeats.
 */
export function parseIotaGroups(body: unknown): IotaGroup[] {
  const groups = parseWith(iotaGroupsSchema, body, "parseIotaGroups: groups.json");
  const seen = new Set<string>();
  const out: IotaGroup[] = [];
  for (const group of groups) {
    if (seen.has(group.refno)) {
      throw new ValidationError(`groups.json lists ${group.refno} twice`, {
        cause: undefined,
        where: "parseIotaGroups: groups.json",
      });
    }
    seen.add(group.refno);
    // Only the two kept fields: load_iota_groups reads no others.
    out.push({ refno: group.refno, name: group.name });
  }
  return out;
}

/** groups.json, unvalidated. The file is about 300 KB, so it gets more than the default timeout. */
export function fetchIotaGroups(url: string): Promise<unknown> {
  return fetchJson(url, { timeoutMs: 30_000 });
}
