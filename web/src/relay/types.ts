// lookup_relay_pairing and answer_relay_pairing (20261028000400_relay_pairing.sql), pinned by
// supabase/tests/relay_pairing.test.sql. Change the SQL, these types and the test together.

/** A code's state as the approval page reads it. `code` is the code normalized (null when it can't be one). */
export type RelayPairing =
  | { status: "pending"; code: string; device_name: string; scopes: string[]; expires_at: string }
  | { status: "expired"; code: string }
  | { status: "unknown"; code: string | null };

/** What answering a code did: approved or denied, or the code was no longer pending (expired) or never existed. */
export interface RelayAnswer {
  status: "approved" | "denied" | "expired" | "unknown";
}
