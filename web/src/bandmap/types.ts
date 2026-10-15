// The band-map Edge Function's payload: cached_band_map() in
// supabase/migrations/20261014000600_band_map.sql, pinned by
// supabase/tests/band_map.test.sql. Change the SQL, this type and the test together.

export type BandMapSource = "dxcluster" | "pota" | "sotawatch";

export interface BandMapSpot {
  id: number;
  callsign: string;
  /** The base call SQL worked out; profile links use it. */
  base_callsign: string;
  frequency_khz: number;
  /** Lowercase ("ft8"), or null when nobody said. */
  mode: string | null;
  source: BandMapSource;
  spot_time: string;
  spotter: string | null;
  /** A POTA park or SOTA summit reference. */
  reference: string | null;
  /** The park's name; summits have none. */
  reference_name: string | null;
}

export interface BandMapPayload {
  /** Only bands with spots, each with one row per base call. */
  bands: { band: string; spots: BandMapSpot[] }[];
  generated_at: string;
}
