// Shape of stats_snapshots.payload. It is produced by refresh_stats_snapshot()
// in supabase/migrations/20261014000200_stats_dxcluster.sql and pinned by
// supabase/tests/stats_snapshot.test.sql; change both together.

export type ModeLabel = "CW" | "SSB" | "FT8/FT4" | "FM" | "Other";
export type Program = "POTA" | "SOTA";
// aprs_packets.packet_type's check constraint (20261014000010).
export type AprsPacketType =
  | "position" | "mic_e" | "object" | "item" | "message" | "status" | "weather"
  | "telemetry" | "nmea" | "third_party" | "capabilities" | "query" | "user_defined" | "other";

export type StatsPayload = {
  totals: {
    spots: number; potaSpots: number; sotaSpots: number; // one per raw_spots row (re-spots count)
    activations: number; potaActivations: number; sotaActivations: number; // distinct (callsign, reference, UTC day)
    chasers: number; potaChasers: number; sotaChasers: number; // distinct spotters, self-spots excluded
    activators: number; references: number;
  };
  peakHour: number; // 0-23 UTC
  busiestSlot: { day: string; hour: number }; // day is YYYY-MM-DD
  daily: { day: string; pota: number; sota: number; rbn: number; aprs: number; dx: number }[]; // exactly 7, oldest first, zero-filled
  hourly: { hour: string; pota: number; sota: number; rbn: number; aprs: number; dx: number }[]; // exactly 168, oldest first, zero-filled, ending at the last complete hour; hour is ISO UTC
  potaByState: Record<string, number>; // 50 states + DC, zero-filled
  sotaAssociations: { code: string; spots: number }[]; // top 10
  bands: { band: string; pota: number; sota: number }[]; // fixed order 160m … 2m
  modes: { label: ModeLabel; percent: number }[]; // integers, sum to 100
  // callsign as spotted (KK4PWJ/P); base is its base call, the profile the page links to. Top 8.
  topActivators: { callsign: string; base: string; references: number; activations: number; spots: number; topBand: string | null }[];
  topReferences: { reference: string; name: string | null; program: Program; activations: number; spots: number }[]; // top 8
  // Every RBN spot in rbn_spots, not the watched copies in raw_spots, which count nowhere.
  rbn: {
    spots: number;
    skimmers: number; // distinct skimmer callsigns
    bands: { band: string; spots: number }[]; // same fixed order as bands
    // Top 8 by spots per base call (K3PA and K3PA-1 are one station), so callsign is a base call;
    // skimmers is distinct over the week, for any form of the call.
    topStations: { callsign: string; spots: number; skimmers: number }[];
  };
  // Every APRS-IS packet: packets from aprs_packet_hours, the rest from the aprs_daily_* rollups.
  aprs: {
    packets: number;
    stations: number; // distinct base calls, so SSIDs combine
    igates: number; // distinct igates, as sent
    types: { type: AprsPacketType; packets: number }[]; // all 14, packets desc then type asc
  };
};

export type LatestStats = { payload: StatsPayload; generatedAt: string };
