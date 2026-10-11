// Shape of stats_snapshots.payload. It is produced by refresh_stats_snapshot()
// in supabase/migrations/20261011000006_stats_self_spots.sql and pinned by
// supabase/tests/stats_snapshot.test.sql; change both together.

export type ModeLabel = "CW" | "SSB" | "FT8/FT4" | "FM" | "Other";
export type Program = "POTA" | "SOTA";

export type StatsPayload = {
  totals: {
    spots: number; potaSpots: number; sotaSpots: number; // one per raw_spots row (re-spots count)
    activations: number; potaActivations: number; sotaActivations: number; // distinct (callsign, reference, UTC day)
    chasers: number; potaChasers: number; sotaChasers: number; // distinct spotters, self-spots excluded
    activators: number; references: number;
  };
  peakHour: number; // 0-23 UTC
  busiestSlot: { day: string; hour: number }; // day is YYYY-MM-DD
  daily: { day: string; pota: number; sota: number }[]; // exactly 7, oldest first, zero-filled
  potaByState: Record<string, number>; // 50 states + DC, zero-filled
  sotaAssociations: { code: string; spots: number }[]; // top 10
  bands: { band: string; pota: number; sota: number }[]; // fixed order 80m … 2m
  modes: { label: ModeLabel; percent: number }[]; // integers, sum to 100
  topActivators: { callsign: string; references: number; activations: number; spots: number; topBand: string | null }[]; // top 8
  topReferences: { reference: string; name: string | null; program: Program; activations: number; spots: number }[]; // top 8
};

export type LatestStats = { payload: StatsPayload; generatedAt: string };
