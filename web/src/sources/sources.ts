export type Volume = "standard" | "high";
export type StatsKey = "pota" | "sota" | "rbn" | "dx" | "aprs";
export type MarkColor = "primary" | "secondary" | "warning" | "success" | "default";

/** One field of the delivered spot, as a webhook receives it (docs/WEBHOOKS.md). */
export interface SchemaField {
  name: string;
  type: string;
  description: string;
  derived: boolean;
}

export interface RunBy {
  operator: string;
  feed: string;
  modes: string;
}

export interface SourceInfo {
  id: string;
  name: string;
  full: string;
  status: "live" | "planned";
  interval: string;
  pollSeconds: number | null;
  desc: string;
  /** False for a feed that is stored but never matched (APRS-IS): no subscription option, no recent-spots tab. */
  alerts: boolean;
  volume: Volume;
  /** Tile and page heading. */
  title: string;
  tagline: string;
  /** Two letters on the tile's mark. */
  mark: string;
  markColor: MarkColor;
  /** The source's key on stats snapshot `hourly` entries; null for planned sources. */
  statsKey: StatsKey | null;
  /** The Visit button links to https://<site>. */
  site: string | null;
  runBy: RunBy | null;
  about: string[];
  showsUp: string[];
  /** Null for APRS-IS, whose packets are never delivered. */
  schema: SchemaField[] | null;
  example: Record<string, unknown> | null;
}

const COMMON_FIELDS: SchemaField[] = [
  { name: "id", type: "integer", description: "Unique id Long Lines assigns to the spot.", derived: true },
  { name: "source", type: "string", description: "", derived: false }, // filled per source
  { name: "spot_time", type: "datetime", description: "When the source reported the spot, in UTC.", derived: false },
  { name: "callsign", type: "string", description: "Callsign that was spotted, as spotted.", derived: false },
  { name: "base_callsign", type: "string", description: "The call without prefixes or suffixes; profiles are keyed on it.", derived: true },
  { name: "spotter", type: "string", description: "Callsign of the person who posted the spot.", derived: false },
  { name: "frequency_khz", type: "number", description: "Frequency in kHz.", derived: false },
  { name: "band", type: "string", description: "Amateur band, worked out from the frequency.", derived: true },
  { name: "mode", type: "string", description: "Operating mode as the spotter entered it, lower case.", derived: false },
  { name: "mode_family", type: "string", description: "cw, phone or digital, worked out from the mode.", derived: true },
  { name: "comment", type: "string", description: "Free text from the spotter.", derived: false },
];

/** The delivered spot's fields for one source: the common ones with per-source wording, then its own. */
function deliveredSchema(id: string, overrides: Record<string, Partial<SchemaField>> = {}, own: SchemaField[] = []): SchemaField[] {
  return [
    ...COMMON_FIELDS.map((f) => ({
      ...f,
      ...(f.name === "source" ? { description: `Always "${id}" for this source.` } : {}),
      ...overrides[f.name],
    })),
    ...own,
  ];
}

export const SOURCES: SourceInfo[] = [
  {
    id: "pota", name: "POTA", full: "Parks on the Air", status: "live", interval: "every 60s", pollSeconds: 60, desc: "Activator spots from api.pota.app", alerts: true,
    volume: "standard", title: "Parks on the Air", tagline: "Activators in parks, self-spotted and spotted by hunters.",
    mark: "PO", markColor: "primary", statsKey: "pota", site: "pota.app",
    runBy: { operator: "Parks on the Air", feed: "Spot list, polled every 60 seconds", modes: "CW, SSB, digital" },
    about: [
      "Parks on the Air is a program where operators activate parks and other operators hunt them. Activators and hunters post spots to the POTA spotting page as they operate.",
      "Long Lines stores every POTA spot, keeps the park details, and shows them on profiles and in Stats.",
    ],
    showsUp: [
      "Callsign profile: last heard, parks and summits, activity",
      "Stats: POTA activity by state, most spotted parks and summits",
      "Subscription filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("pota", {}, [
      { name: "pota_reference", type: "string", description: "Park reference.", derived: false },
      { name: "pota_park_name", type: "string", description: "Park name.", derived: false },
      { name: "pota_location", type: "string", description: "Park locations as POTA lists them, comma separated.", derived: false },
    ]),
    example: {
      id: 58161241, source: "pota", spot_time: "2026-10-14T14:30:05+00:00", callsign: "KK4PWJ", base_callsign: "KK4PWJ",
      spotter: "K3XYZ", frequency_khz: 14062.0, band: "20m", mode: "cw", mode_family: "cw", comment: "Strong signal",
      pota_reference: "US-2763", pota_park_name: "Falls Lake SRA", pota_location: "US-NC", sota_summit_ref: null,
    },
  },
  {
    id: "sotawatch", name: "SOTAwatch", full: "Summits on the Air", status: "live", interval: "every 30s", pollSeconds: 30, desc: "Summit activation spots from SOTAwatch", alerts: true,
    volume: "standard", title: "SOTA", tagline: "Activators on mountain summits around the world.",
    mark: "SO", markColor: "secondary", statsKey: "sota", site: "sotawatch.sota.org.uk",
    runBy: { operator: "Summits on the Air", feed: "Spot list, polled every 30 seconds", modes: "CW, SSB, FM, digital" },
    about: [
      "Summits on the Air is an award program for portable operation from mountain summits. Activators and chasers post spots to SOTAwatch as they operate.",
      "Long Lines stores every SOTAwatch spot, keeps the summit reference, and shows them on profiles and in Stats.",
    ],
    showsUp: [
      "Callsign profile: last heard, parks and summits, activity",
      "Stats: top SOTA associations, most spotted parks and summits",
      "Subscription filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("sotawatch", {}, [
      { name: "sota_summit_ref", type: "string", description: "Summit reference.", derived: false },
    ]),
    example: {
      id: 58161302, source: "sotawatch", spot_time: "2026-10-14T14:31:40+00:00", callsign: "KK4PWJ/P", base_callsign: "KK4PWJ",
      spotter: "KK4PWJ", frequency_khz: 14062.0, band: "20m", mode: "cw", mode_family: "cw", comment: "QRV now",
      pota_reference: null, pota_park_name: null, pota_location: null, sota_summit_ref: "W4C/CM-001",
    },
  },
  {
    id: "rbn", name: "RBN", full: "Reverse Beacon Network", status: "live", interval: "streaming", pollSeconds: 60, desc: "CW and digital skimmer spots", alerts: true,
    volume: "high", title: "Reverse Beacon Network", tagline: "CW and RTTY signals heard by skimmers around the world.",
    mark: "RB", markColor: "warning", statsKey: "rbn", site: "reversebeacon.net",
    runBy: { operator: "Reverse Beacon Network volunteers", feed: "Telnet stream of skimmer spots", modes: "CW, RTTY" },
    about: [
      "The Reverse Beacon Network is a network of automated receivers, called skimmers, that listen across the bands and report every CW and RTTY signal they decode, with signal strength and speed.",
      "Long Lines stores every RBN spot. You see them on a callsign profile under \"Heard by\" and in Stats.",
    ],
    showsUp: [
      "Callsign profile: Heard by, last heard, activity",
      "Stats: RBN skimmers, most heard on RBN",
      "Subscription filters: Bands, Modes, Callsigns or Callsign groups (required)",
    ],
    schema: deliveredSchema("rbn", {
      spotter: { description: "Callsign of the skimmer that heard the signal." },
      mode: { description: "CW or RTTY, as the skimmer decoded it." },
      comment: { description: "Signal strength and speed as the skimmer reported them." },
    }),
    example: {
      id: 58161377, source: "rbn", spot_time: "2026-10-14T14:30:12+00:00", callsign: "KK4PWJ", base_callsign: "KK4PWJ",
      spotter: "W3LPL", frequency_khz: 14062.0, band: "20m", mode: "cw", mode_family: "cw", comment: "18 dB 24 WPM CQ",
      pota_reference: null, pota_park_name: null, pota_location: null, sota_summit_ref: null,
    },
  },
  {
    id: "dxcluster", name: "DX Cluster", full: "DXSpider network", status: "live", interval: "streaming", pollSeconds: 60, desc: "Human-entered DX spots", alerts: true,
    volume: "standard", title: "DX Cluster", tagline: "Spots entered by operators and shared across cluster nodes.",
    mark: "DX", markColor: "success", statsKey: "dx", site: null,
    runBy: { operator: "Volunteer cluster node operators", feed: "Telnet stream from a DXSpider node", modes: "Any, as the spotter enters it" },
    about: [
      "A DX Cluster is a network of nodes where operators post the stations they hear, often rare or distant ones, for everyone connected to see.",
      "Long Lines stores every DX Cluster spot and shows them on profiles. Only subscriptions that pick DX Cluster get them.",
    ],
    showsUp: [
      "Callsign profile: last heard, activity",
      "Subscription filters: Bands, Modes, Callsigns, Callsign groups",
      "Not in Stats",
    ],
    schema: deliveredSchema("dxcluster", { mode: { description: "From the comment, else the band plan.", derived: true } }),
    example: {
      id: 58161420, source: "dxcluster", spot_time: "2026-10-14T14:32:00+00:00", callsign: "KK4PWJ", base_callsign: "KK4PWJ",
      spotter: "K3XYZ", frequency_khz: 14025.0, band: "20m", mode: "cw", mode_family: "cw", comment: "CQ CQ",
      pota_reference: null, pota_park_name: null, pota_location: null, sota_summit_ref: null,
    },
  },
  {
    id: "aprs", name: "APRS-IS", full: "Automatic Packet Reporting System", status: "live", interval: "streaming", pollSeconds: 60, desc: "Every packet on the worldwide APRS-IS feed", alerts: false,
    volume: "high", title: "APRS-IS", tagline: "Position, weather and message packets from the worldwide APRS-IS network.",
    mark: "AP", markColor: "warning", statsKey: "aprs", site: "aprs2.net",
    runBy: { operator: "APRS-IS tier 2 network volunteers", feed: "Full feed over TCP, receive only", modes: "APRS packets" },
    about: [
      "APRS-IS links the world's APRS radio networks over the internet. Igates forward the packets they hear, from positions and weather reports to messages.",
      "Long Lines stores every packet on the full feed for about two days and archives it after that. Packets are not spots: they never reach profiles or subscriptions, so there is no schema or recent spots list here. You see them in Stats.",
    ],
    showsUp: ["Stats: APRS-IS packets, stations, igates and packet types", "Not on profiles or in subscriptions"],
    schema: null,
    example: null,
  },
  {
    id: "pskreporter", name: "PSK Reporter", full: "PSK Reporter", status: "planned", interval: "streaming", pollSeconds: null, desc: "FT8, FT4 and other digital mode reports", alerts: true,
    volume: "high", title: "PSK Reporter", tagline: "Digital-mode reception reports from monitoring stations.",
    mark: "PS", markColor: "default", statsKey: null, site: null, runBy: null, about: [], showsUp: [], schema: null, example: null,
  },
  {
    id: "wwff", name: "WWFF", full: "World Wide Flora & Fauna", status: "planned", interval: "streaming", pollSeconds: null, desc: "WWFF reference activations", alerts: true,
    volume: "standard", title: "WWFF", tagline: "World Wide Flora and Fauna activations.",
    mark: "WW", markColor: "default", statsKey: null, site: null, runBy: null, about: [], showsUp: [], schema: null, example: null,
  },
];

/** A live source by id, for /sources/:id; planned and unknown ids give undefined. */
export function findLiveSource(id: string | undefined): SourceInfo | undefined {
  return SOURCES.find((s) => s.id === id && s.status === "live");
}

/** Sources a subscription can pick and the recent-spots tabs show: live and alerting. */
export const LIVE_SOURCES = SOURCES.filter((s) => s.status === "live" && s.alerts);

export function sourceName(id: string): string {
  return SOURCES.find((s) => s.id === id)?.name ?? id;
}

export const BANDS = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"];
export const MODES = ["digital", "cw", "ssb", "fm", "am", "ft8", "ft4", "rtty", "psk"];

/** "digital" is a mode family (see _shared/modes.ts); everything else is a specific mode. */
export function modeLabel(m: string): string {
  return m === "digital" ? "Any digital" : m.toUpperCase();
}
