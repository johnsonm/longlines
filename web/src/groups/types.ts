// A row of list_callsign_groups() (supabase/migrations/20261013000210_callsign_groups_ui.sql).
// Members are base calls, alphabetical. on_air is built in SQL: the members
// spotted in raw_spots in the last 30 minutes and the newest of those spots.

export interface GroupSpot {
  callsign: string; // as spotted (KK4PWJ/P), not the member's base call
  frequency_khz: number | null;
  band: string | null;
  mode: string | null;
  source: string;
  reference: string | null; // POTA park or SOTA summit
  spot_time: string;
}

export interface CallsignGroup {
  id: string;
  name: string;
  callsigns: string[];
  member_count: number;
  subscription_count: number;
  updated_at: string;
  on_air: { count: number; latest: GroupSpot | null };
}

export interface GroupInput {
  id?: string;
  name: string;
  callsigns: string[];
}

/** What normalize_group_callsigns returns: base calls to store, and values that aren't callsigns. */
export interface NormalizedCallsigns {
  callsigns: string[];
  rejected: string[];
}
