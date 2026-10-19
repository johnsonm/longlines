// The group statistics payload built by group_statistics_at (supabase/migrations/
// 20261019000400_group_statistics.sql), pinned by supabase/tests/group_statistics.test.sql:
// change the SQL, this type and the test together. Every figure, ranking and
// list length is SQL's; the page only words and draws them.

export type GroupPeriod = "7d" | "30d";
export type ModeBucket = "CW" | "SSB" | "FT8/FT4" | "FM" | "Other";
export type TopList = "spots" | "days" | "cw" | "ssb" | "digital" | "parks";

export interface TopEntry {
  callsign: string;
  value: number;
}

export interface GroupMember {
  callsign: string; // base call
  spots: number; // in the period
  days: number; // UTC days heard in the period
  mainMode: ModeBucket | null; // null without spots in the period
  lastHeard: string | null; // ISO UTC; null when never heard
}

export interface GroupPlace {
  reference: string;
  name: string | null; // SOTA summits have none
  program: "POTA" | "SOTA" | "WWFF";
  times: number; // activations: one member at the reference on one UTC day
  by?: string[]; // absent on a public page without callsigns
}

export interface GroupStatistics {
  period: GroupPeriod;
  generatedAt: string;
  memberCount: number; // hidden calls left out
  kpis: {
    spots: number;
    previousSpots: number;
    membersHeard: number;
    activations: { pota: number; sota: number; wwff: number };
    places: { parks: number; summits: number }; // parks are POTA and WWFF references
  };
  daily: { day: string; spots: number }[]; // the period's days, oldest first, zero filled
  calendar: { day: string; spots: number; members: number }[]; // the past 365 days with spots, oldest first
  // Absent from a public page whose owner hides callsigns (group_stats_redact).
  top?: Record<TopList, TopEntry[]>; // up to three each, members with none left out
  members?: GroupMember[]; // every member, ranked by spots, days, callsign
  bands: { band: string; spots: number }[]; // the fixed twelve, zero filled
  modes: { label: ModeBucket; spots: number }[]; // bucket order, empty buckets left out
  places: GroupPlace[]; // the top 10 by activations
}

/** get_group_statistics: the payload plus the owner's header and sharing settings. */
export interface OwnerGroup {
  id: string;
  name: string;
  public: boolean;
  show_callsigns: boolean;
  public_slug: string | null;
  member_count: number; // every stored member, hidden calls included, as the member editor counts
  subscription_count: number;
}

export interface OwnerGroupStatistics extends GroupStatistics {
  group: OwnerGroup;
}

/** public_group_statistics through the group-page function: the payload, redacted unless callsigns are shown. */
export interface PublicGroupStatistics extends GroupStatistics {
  group: { name: string; member_count: number; show_callsigns: boolean };
}

/** A row of list_group_summaries(): a landing card. Figures are null for a group not built yet. */
export interface GroupSummary {
  id: string;
  public: boolean;
  spots: number | null;
  members_heard: number | null;
  member_count: number | null;
  daily: number[] | null; // the last 30 days, oldest first
  on_air: string[]; // members heard in the last 30 minutes, newest first
}
