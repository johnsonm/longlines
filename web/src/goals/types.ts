// The goal payloads, as the SQL builds them (supabase/migrations/20261029001100_goals.sql).
// get_goal's shape (GoalProgress) is pinned by supabase/tests/goals.test.sql;
// change the SQL, these types and the test together.

export type GoalKind = "state" | "park" | "band";
export type GoalStatus = "active" | "complete" | "ended";
export type GoalMarking = "relay" | "hand";
export type CompleteWhen = "all" | "at_least";

/** goal_card: one list as the index shows it. */
export interface GoalCard {
  id: string;
  name: string;
  /** YYYY-MM-DD UTC days, both null for "No end date"; ends_on is inclusive. */
  starts_on: string | null;
  ends_on: string | null;
  marking: GoalMarking;
  status: GoalStatus;
  completed_at: string | null;
  requirement_count: number;
  /** Requirements added up, each counted up to its target: "18 of 64 worked". */
  worked: number;
  total: number;
  /** What incomplete requirements still lack, by kind. */
  needed_by_kind: Record<GoalKind, number>;
  /** The owner's connections whose rules name the list. */
  connection_count: number;
  updated_at: string;
}

/** How a contact marked an entry: the logged contact and, for a park or its state, the POTA spot it matched. */
export interface GoalEvidence {
  worked_call: string;
  contact_time: string;
  logger_app: string | null;
  matched_spot_time: string | null;
}

export interface GoalEntry {
  /** A state code, an upper-cased POTA reference or a band name ("20m"). */
  value: string;
  /** A park's name from the reference catalog; null for states, bands and parks outside it. */
  label: string | null;
  position: number;
  worked_at: string | null;
  worked_how: "contact" | "hand" | null;
  /** Set for a contact mark only. */
  evidence: GoalEvidence | null;
}

export interface GoalRequirement {
  id: string;
  kind: GoalKind;
  complete_when: CompleteWhen;
  at_least: number | null;
  position: number;
  complete: boolean;
  /** Worked entries up to the target. */
  worked: number;
  /** The entry count for "all", else at_least. */
  target: number;
  entries: GoalEntry[];
}

export interface GoalReviewCandidate {
  reference: string;
  name: string | null;
}

/** An open "Needs a look": a logged contact whose park couldn't be told. */
export interface GoalReview {
  id: string;
  worked_call: string;
  band: string | null;
  mode: string | null;
  contact_time: string;
  /** The distinct parks spotted around the contact; empty for none. */
  candidates: GoalReviewCandidate[];
}

export interface GoalRelay {
  /** recent: a contact in the last 7 days; never: no relay paired and no contact; else stale. */
  status: "never" | "recent" | "stale";
  last_contact_at: string | null;
  logger_app: string | null;
  relay_count: number;
}

/** A connection whose rules name the list. */
export interface GoalUsedBy {
  id: string;
  name: string;
  sources: string[];
  destination_count: number;
}

/** get_goal: the progress page. */
export interface GoalProgress {
  list: GoalCard;
  requirements: GoalRequirement[];
  reviews: GoalReview[];
  relay: GoalRelay;
  used_by: GoalUsedBy[];
  /** The account's first logged contact: what Long Lines knows contacts since. */
  first_contact_at: string | null;
}

/**
 * preview_goal_window: one entry a contact marks worked now that a save with the new window
 * or marking would send back to needed. before_start and after_end go by the UTC day of the
 * contact that marks it now; by_hand is a switch to "By hand only".
 */
export interface GoalWindowLoss {
  requirement_id: string;
  kind: GoalKind;
  value: string;
  worked_at: string;
  reason: "before_start" | "after_end" | "by_hand";
}

/** save_goal's payload: a whole list, created without an id, else replaced. */
export type GoalRequirementInput = {
  id?: string;
  kind: GoalKind;
  complete_when: CompleteWhen;
  at_least: number | null;
  entries: string[];
};

export type GoalInput = {
  id?: string;
  name: string;
  starts_on: string | null;
  ends_on: string | null;
  marking: GoalMarking;
  requirements: GoalRequirementInput[];
};
