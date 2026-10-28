// Logged contacts from Long Lines Relay: one item of a POST /relay/v1/contacts request, checked
// and shaped into the item apply_logged_contacts takes. Pure; the relay-api handler does the I/O.
// The wire contract is docs/contract.md in sonyccd/longlines-relay (section 6); the design is
// docs/superpowers/specs/2026-10-28-logged-contacts-design.md.
//
// The handler validates the request (loggedRequestSchema: a 400 for the whole request), then
// calls normalizeLoggedContact per item in order. An item this module rejects (invalid,
// clock_skew, too_old) never reaches the database; the rest go to apply_logged_contacts in one
// call, which applies them in order and rejects an upsert whose mycall is another station's
// (mycall_mismatch, decided in SQL by base_callsign()). mergeLoggedResults puts both kinds of
// result back in input order.

import { z } from "zod";
import { bandForFrequency } from "./bands.ts";
import { ValidationError } from "./errors.ts";
import { contentHash } from "./hash.ts";
import { modeFamily, resolveMode } from "./modes.ts";
import { assertStorableSpot } from "./normalize.ts";
import { jsonObjectSchema } from "./types.ts";
import type { JsonObject, NormalizedSpot } from "./types.ts";
import { parseWith } from "./validate.ts";

/** An upsert logged longer ago than this is rejected as too_old. Deletes never age out. */
export const MAX_CONTACT_AGE_MS = 30 * 60 * 1000;
/** Any item logged further ahead of the server's clock than this is rejected as clock_skew. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_CONTACTS_PER_REQUEST = 100;
export const MAX_EXTERNAL_ID_LENGTH = 256;
/** The highest frequency an item may carry, in Hz (300 GHz). */
export const MAX_FREQUENCY_HZ = 300_000_000_000;

export type LoggedOp = "upsert" | "delete";
export type LoggedStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "retracted"
  | "unknown"
  | "rejected";
export type LoggedRejectReason = "too_old" | "clock_skew" | "mycall_mismatch" | "invalid";

/** An upsert item as the contract defines it (6.1), after trimming and upper-casing. */
export interface LoggedUpsert {
  external_id: string;
  op: "upsert";
  mycall: string;
  call: string;
  frequency_hz: number;
  band: string | null;
  mode: string;
  timestamp_utc: string;
  logger_app?: string | null;
}

/** A delete item: only the id, the op and the time are read; anything else is ignored. */
export interface LoggedDelete {
  external_id: string;
  op: "delete";
  timestamp_utc: string;
}

export type LoggedContact = LoggedUpsert | LoggedDelete;

/** A request item as the request-level check reads it: any object with a valid external_id. */
export interface LoggedRequestItem {
  external_id: string;
}

/** A POST /contacts body as the request-level check reads it. Each item is checked later. */
export interface LoggedRequest {
  relay_version: string;
  contacts: LoggedRequestItem[];
}

/** The account an item is applied for. */
export interface LoggedAccount {
  userId: string;
}

/** One item of apply_logged_contacts' p_items. */
export interface LoggedApplyItem {
  op: LoggedOp;
  external_id: string;
  logger_app: string | null;
  relay_version: string;
  /** The spot to store for an upsert; null for a delete. */
  spot: NormalizedSpot | null;
}

/** One item's result, as POST /contacts returns it (6.4) and apply_logged_contacts answers. */
export interface LoggedResult {
  external_id: string;
  status: LoggedStatus;
  /** Present only when status is rejected. */
  reason?: LoggedRejectReason;
}

/** An item that goes to apply_logged_contacts. */
export interface LoggedApply {
  kind: "apply";
  item: LoggedApplyItem;
}

/** An item this module already answered: it never reaches the database. */
export interface LoggedAnswered {
  kind: "result";
  result: LoggedResult;
}

export type LoggedOutcome = LoggedApply | LoggedAnswered;

const NO_WHITESPACE_CALL = /^\S{1,64}$/;
const TIMESTAMP_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** `YYYY-MM-DDTHH:MM:SSZ` exactly, naming a real instant (no February 30th). */
function isTimestampUtc(value: string): boolean {
  if (!TIMESTAMP_UTC.test(value)) {
    return false;
  }
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return false;
  }
  return time.toISOString().replace(".000Z", "Z") === value;
}

/** An item's id: 1 to 256 characters, exactly as sent (the client trims it). */
export const loggedExternalIdSchema: z.ZodType<string> = z.string().min(1).max(
  MAX_EXTERNAL_ID_LENGTH,
);

const timestampUtcSchema: z.ZodType<string> = z.string().refine(isTimestampUtc, {
  error: "expected YYYY-MM-DDTHH:MM:SSZ",
});

/** A call as logged: trimmed and upper-cased, 1 to 64 characters, no whitespace. */
const callSchema: z.ZodType<string> = z.string().trim().toUpperCase().regex(NO_WHITESPACE_CALL);

// The relay is our client, but deployed relays lag the server and the contract has the server
// ignore fields it does not know (section 2), so items are loose, not strict. Not annotated: a
// member of the discriminated union below must keep its literal op.
const upsertSchema = z.looseObject({
  external_id: loggedExternalIdSchema,
  op: z.literal("upsert"),
  mycall: callSchema,
  call: callSchema,
  frequency_hz: z.number().int().min(1).max(MAX_FREQUENCY_HZ),
  band: z.string().max(16).nullable(),
  mode: z.string().trim().toUpperCase().min(1).max(32),
  timestamp_utc: timestampUtcSchema,
  logger_app: z.string().max(64).nullable().optional(),
});
const deleteSchema = z.looseObject({
  external_id: loggedExternalIdSchema,
  op: z.literal("delete"),
  timestamp_utc: timestampUtcSchema,
});

/** One contact item (6.1). A failure is the item's rejected / invalid result, not a 400. */
export const loggedContactSchema: z.ZodType<LoggedContact> = z.discriminatedUnion("op", [
  upsertSchema,
  deleteSchema,
]);

const requestItemSchema: z.ZodType<LoggedRequestItem> = z.looseObject({
  external_id: loggedExternalIdSchema,
});

/**
 * The request-level check (6.1): a 400 invalid_request, nothing applied, when it fails. Each
 * item is only checked for its external_id here; normalizeLoggedContact checks the rest.
 */
export const loggedRequestSchema: z.ZodType<LoggedRequest> = z.looseObject({
  relay_version: z.string().min(1).max(32),
  contacts: z.array(requestItemSchema).min(1).max(MAX_CONTACTS_PER_REQUEST),
});

const resultSchema: z.ZodType<LoggedResult> = z.looseObject({
  external_id: z.string(),
  status: z.enum(["created", "updated", "unchanged", "retracted", "unknown", "rejected"]),
  reason: z.enum(["too_old", "clock_skew", "mycall_mismatch", "invalid"]).optional(),
});

/** apply_logged_contacts' reply: one result per item it was given, in order. */
export const loggedResultsSchema: z.ZodType<LoggedResult[]> = z.array(resultSchema);

function rejected(externalId: string, reason: LoggedRejectReason): LoggedAnswered {
  return { kind: "result", result: { external_id: externalId, status: "rejected", reason } };
}

/** The upsert's spot: spotter is mycall as logged, callsign the worked call as logged. */
async function spotOf(
  contact: LoggedUpsert,
  raw: JsonObject,
  account: LoggedAccount,
  time: Date,
  now: Date,
): Promise<NormalizedSpot> {
  const frequencyKhz = contact.frequency_hz / 1000;
  const band = bandForFrequency(frequencyKhz);
  const mode = resolveMode(contact.mode, "");
  // Content is the six fields after normalization (contract 6.3), in this fixed order; the
  // request's band is the client's and only feeds its external_id, so the stored band stands in.
  const hash = await contentHash([
    contact.mycall,
    contact.call,
    contact.frequency_hz,
    band,
    contact.mode,
    contact.timestamp_utc,
  ]);
  const spot: NormalizedSpot = {
    source: "logged",
    source_spot_id: `${account.userId}|${contact.external_id}`,
    content_hash: hash,
    spot_time: time.toISOString(),
    callsign: contact.call,
    spotter: contact.mycall,
    frequency_khz: frequencyKhz,
    band,
    mode,
    mode_family: modeFamily(mode),
    comment: "",
    pota_reference: null,
    pota_park_name: null,
    pota_location: null,
    sota_summit_ref: null,
    wwff_reference: null,
    wwff_reference_name: null,
    wwbota_references: null,
    wwbota_reference_name: null,
    iota_reference: null,
    raw_payload: raw,
  };
  assertStorableSpot(spot, now);
  return spot;
}

/**
 * One request item, checked in the contract's order (6.3): invalid, clock_skew, too_old (upsert
 * only). A passing item becomes an apply_logged_contacts item; mycall_mismatch is SQL's.
 * Throws ValidationError for an item without a valid external_id, which the request-level check
 * (loggedRequestSchema) refuses first.
 */
export async function normalizeLoggedContact(
  raw: unknown,
  account: LoggedAccount,
  relayVersion: string,
  now: Date,
): Promise<LoggedOutcome> {
  const item = parseWith(requestItemSchema, raw, "normalizeLoggedContact: item");
  const externalId = item.external_id;
  const parsed = loggedContactSchema.safeParse(raw);
  if (!parsed.success) {
    return rejected(externalId, "invalid");
  }
  const contact = parsed.data;
  const time = new Date(contact.timestamp_utc);
  if (time.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS) {
    return rejected(externalId, "clock_skew");
  }
  if (contact.op === "delete") {
    return {
      kind: "apply",
      item: {
        op: "delete",
        external_id: externalId,
        logger_app: null,
        relay_version: relayVersion,
        spot: null,
      },
    };
  }
  if (now.getTime() - time.getTime() > MAX_CONTACT_AGE_MS) {
    return rejected(externalId, "too_old");
  }
  let loggerApp: string | null = null;
  if (contact.logger_app !== undefined) {
    loggerApp = contact.logger_app;
  }
  // The item exactly as the relay sent it, for raw_payload.
  const payload = parseWith(jsonObjectSchema, raw, "normalizeLoggedContact: item");
  return {
    kind: "apply",
    item: {
      op: "upsert",
      external_id: externalId,
      logger_app: loggerApp,
      relay_version: relayVersion,
      spot: await spotOf(contact, payload, account, time, now),
    },
  };
}

/** The items to send to apply_logged_contacts, in input order. */
export function loggedApplyItems(outcomes: readonly LoggedOutcome[]): LoggedApplyItem[] {
  const items: LoggedApplyItem[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "apply") {
      items.push(outcome.item);
    }
  }
  return items;
}

/**
 * Every item's result in input order: this module's answers where it gave one, else the next of
 * apply_logged_contacts' results. Throws ValidationError when the reply does not line up.
 */
export function mergeLoggedResults(
  outcomes: readonly LoggedOutcome[],
  applied: readonly LoggedResult[],
): LoggedResult[] {
  const results: LoggedResult[] = [];
  let next = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === "result") {
      results.push(outcome.result);
      continue;
    }
    const result = applied[next];
    if (result === undefined || result.external_id !== outcome.item.external_id) {
      throw new ValidationError(
        `apply_logged_contacts answered item ${String(next)} out of line`,
        { cause: undefined, where: "mergeLoggedResults: apply_logged_contacts reply" },
      );
    }
    results.push(result);
    next++;
  }
  if (next !== applied.length) {
    throw new ValidationError(
      `apply_logged_contacts answered ${String(applied.length)} items for ${String(next)}`,
      { cause: undefined, where: "mergeLoggedResults: apply_logged_contacts reply" },
    );
  }
  return results;
}
