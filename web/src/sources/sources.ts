export type Volume = "standard" | "high";
export type StatsKey = "pota" | "sota" | "wwff" | "wwbota" | "iota" | "logged" | "rbn" | "dx" | "aprs";
export type MarkColor = "primary" | "secondary" | "warning" | "success" | "error" | "default";

/**
 * One field of the delivered spot as a webhook receives it with the default
 * settings (docs/WEBHOOKS.md): `name` is the snake_case key, kHz for frequency.
 */
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
  /** Null for a source that is not polled (logged contacts arrive when someone logs), so it is never delayed. */
  pollSeconds: number | null;
  desc: string;
  /**
   * False for a feed that is stored but never matched: no connection option. Every live source matches today;
   * APRS-IS only for the stations a connection names.
   */
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
  /**
   * The source whose spots carry this one (IOTA rides on DX Cluster), else null. Such an entry is
   * never offered as a connection source; its health is the carrier's, and its connections are the
   * carrier's.
   */
  via: string | null;
  runBy: RunBy | null;
  about: string[];
  showsUp: string[];
  /** Null for a source whose spots are never delivered. */
  schema: SchemaField[] | null;
  example: Record<string, unknown> | null;
}

/**
 * The webhook field catalog in webhook_fields() order, with the default
 * (snake_case, kHz) keys. Per-source wording fills `source` and, where a
 * source has no value, `reference`, `place_name`, `state` and `url`.
 */
const COMMON_FIELDS: SchemaField[] = [
  { name: "id", type: "integer", description: "Unique id Long Lines assigns to the spot.", derived: true },
  { name: "time", type: "string", description: "When the source reported the spot: ISO 8601 in UTC, whole seconds. Or Unix seconds.", derived: false },
  { name: "callsign", type: "string", description: "Callsign that was spotted, as spotted.", derived: false },
  { name: "first_name", type: "string", description: "First name on the spotted call's license, when Long Lines has one. Not sent by default.", derived: true },
  { name: "last_name", type: "string", description: "Last name on the spotted call's license, when Long Lines has one. Not sent by default.", derived: true },
  { name: "frequency_khz", type: "number", description: "Frequency in kHz. MHz or Hz change the key to frequency_mhz or frequency_hz.", derived: false },
  { name: "mode", type: "string", description: "Operating mode as the spotter entered it, lower case.", derived: false },
  { name: "band", type: "string", description: "Amateur band, worked out from the frequency.", derived: true },
  { name: "source", type: "string", description: "", derived: false }, // filled per source
  { name: "reference", type: "string", description: "", derived: false }, // filled per source
  { name: "place_name", type: "string", description: "", derived: false }, // filled per source
  { name: "state", type: "string", description: "", derived: true }, // filled per source
  { name: "spotter", type: "string", description: "Callsign of the person who posted the spot.", derived: false },
  { name: "country", type: "string", description: "The callsign's country, as cty.dat names it. Not sent by default.", derived: true },
  { name: "url", type: "string", description: "", derived: true }, // filled per source
  { name: "comment", type: "string", description: "Free text from the spotter. Not sent by default.", derived: false },
];

/** The wording for a field this source never has a value for. */
function noValue(label: string): Partial<SchemaField> {
  return { description: `No value on ${label} spots, so the key is left out.` };
}

/** The delivered spot's fields for one source: the catalog with per-source wording. */
function deliveredSchema(id: string, overrides: Record<string, Partial<SchemaField>>): SchemaField[] {
  return COMMON_FIELDS.map((f) => ({
    ...f,
    ...(f.name === "source" ? { description: `Always "${id}" for this source.` } : {}),
    ...overrides[f.name],
  }));
}

export const SOURCES: SourceInfo[] = [
  {
    id: "pota", name: "POTA", full: "Parks on the Air", status: "live", interval: "every 60s", pollSeconds: 60, desc: "Activator spots from api.pota.app", alerts: true,
    volume: "standard", title: "Parks on the Air", tagline: "Activators in parks, self-spotted and spotted by hunters.",
    mark: "PO", markColor: "primary", statsKey: "pota", site: "pota.app", via: null,
    runBy: { operator: "Parks on the Air", feed: "Spot list, polled every 60 seconds", modes: "CW, SSB, digital" },
    about: [
      "Parks on the Air is a program where operators activate parks and other operators hunt them. Activators and hunters post spots to the POTA spotting page as they operate.",
      "Long Lines stores every POTA spot, keeps the park details, and shows them on profiles and in Stats.",
    ],
    showsUp: [
      "Callsign profile: last heard, parks and summits, activity",
      "Stats: POTA activity by state, most spotted parks and summits",
      "Connection filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("pota", {
      reference: { description: "Park reference." },
      place_name: { description: "Park name." },
      state: { description: "The park's state or province, from its location after the dash (US-NC is NC); several joined by /." },
      url: { description: "The park's page on pota.app. Not sent by default." },
    }),
    example: {
      id: 58161241, time: "2026-10-14T14:30:05Z", callsign: "KK4PWJ", frequency_khz: 14062, mode: "cw", band: "20m",
      source: "pota", reference: "US-2763", place_name: "Falls Lake SRA", state: "NC", spotter: "K3XYZ",
    },
  },
  {
    id: "sotawatch", name: "SOTAwatch", full: "Summits on the Air", status: "live", interval: "every 30s", pollSeconds: 30, desc: "Summit activation spots from SOTAwatch", alerts: true,
    volume: "standard", title: "SOTA", tagline: "Activators on mountain summits around the world.",
    mark: "SO", markColor: "secondary", statsKey: "sota", site: "sotawatch.sota.org.uk", via: null,
    runBy: { operator: "Summits on the Air", feed: "Spot list, polled every 30 seconds", modes: "CW, SSB, FM, digital" },
    about: [
      "Summits on the Air is an award program for portable operation from mountain summits. Activators and chasers post spots to SOTAwatch as they operate.",
      "Long Lines stores every SOTAwatch spot, keeps the summit reference, and shows them on profiles and in Stats.",
    ],
    showsUp: [
      "Callsign profile: last heard, parks and summits, activity",
      "Stats: top SOTA associations, most spotted parks and summits",
      "Connection filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("sotawatch", {
      reference: { description: "Summit reference." },
      place_name: noValue("SOTA"),
      state: noValue("SOTA"),
      url: { description: "The summit's page on summits.sota.org.uk. Not sent by default." },
    }),
    example: {
      id: 58161302, time: "2026-10-14T14:31:40Z", callsign: "KK4PWJ/P", frequency_khz: 14062, mode: "cw", band: "20m",
      source: "sotawatch", reference: "W4C/CM-001", spotter: "KK4PWJ",
    },
  },
  {
    id: "rbn", name: "RBN", full: "Reverse Beacon Network", status: "live", interval: "streaming", pollSeconds: 60, desc: "CW and digital skimmer spots", alerts: true,
    volume: "high", title: "Reverse Beacon Network", tagline: "CW and RTTY signals heard by skimmers around the world.",
    mark: "RB", markColor: "warning", statsKey: "rbn", site: "reversebeacon.net", via: null,
    runBy: { operator: "Reverse Beacon Network volunteers", feed: "Telnet stream of skimmer spots", modes: "CW, RTTY" },
    about: [
      "The Reverse Beacon Network is a network of automated receivers, called skimmers, that listen across the bands and report every CW and RTTY signal they decode, with signal strength and speed.",
      "Long Lines stores every RBN spot. You see them on a callsign profile under \"Heard by\" and in Stats.",
    ],
    showsUp: [
      "Callsign profile: Heard by, last heard, activity",
      "Stats: RBN skimmers, most heard on RBN",
      "Connection filters: Bands, Modes, Callsigns or Callsign groups (required)",
    ],
    schema: deliveredSchema("rbn", {
      spotter: { description: "Callsign of the skimmer that heard the signal." },
      mode: { description: "CW or RTTY, as the skimmer decoded it." },
      reference: noValue("RBN"),
      place_name: noValue("RBN"),
      state: noValue("RBN"),
      url: noValue("RBN"),
      comment: { description: "Signal strength and speed as the skimmer reported them. Not sent by default." },
    }),
    example: {
      id: 58161377, time: "2026-10-14T14:30:12Z", callsign: "KK4PWJ", frequency_khz: 14062, mode: "cw", band: "20m",
      source: "rbn", spotter: "W3LPL",
    },
  },
  {
    id: "dxcluster", name: "DX Cluster", full: "DXSpider network", status: "live", interval: "streaming", pollSeconds: 60, desc: "Human-entered DX spots", alerts: true,
    volume: "standard", title: "DX Cluster", tagline: "Spots entered by operators and shared across cluster nodes.",
    mark: "DX", markColor: "success", statsKey: "dx", site: null, via: null,
    runBy: { operator: "Volunteer cluster node operators", feed: "Telnet stream from a DXSpider node", modes: "Any, as the spotter enters it" },
    about: [
      "A DX Cluster is a network of nodes where operators post the stations they hear, often rare or distant ones, for everyone connected to see.",
      "Long Lines stores every DX Cluster spot and shows them on profiles. Only connections that pick DX Cluster get them.",
    ],
    showsUp: [
      "Callsign profile: last heard, activity",
      "Connection filters: Bands, Modes, Callsigns, Callsign groups",
      "Not in Stats",
    ],
    schema: deliveredSchema("dxcluster", {
      mode: { description: "From the comment, else the band plan.", derived: true },
      reference: noValue("DX Cluster"),
      place_name: noValue("DX Cluster"),
      state: noValue("DX Cluster"),
      url: noValue("DX Cluster"),
    }),
    example: {
      id: 58161420, time: "2026-10-14T14:32:00Z", callsign: "KK4PWJ", frequency_khz: 14025, mode: "cw", band: "20m",
      source: "dxcluster", spotter: "K3XYZ",
    },
  },
  {
    id: "aprs", name: "APRS-IS", full: "Automatic Packet Reporting System", status: "live", interval: "streaming", pollSeconds: 60, desc: "Every packet on the worldwide APRS-IS feed", alerts: true,
    volume: "high", title: "APRS-IS", tagline: "Position, weather and message packets from the worldwide APRS-IS network.",
    mark: "AP", markColor: "warning", statsKey: "aprs", site: "aprs2.net", via: null,
    runBy: { operator: "APRS-IS tier 2 network volunteers", feed: "Full feed over TCP, receive only", modes: "APRS packets" },
    about: [
      "APRS-IS links the world's APRS radio networks over the internet. Igates forward the packets they hear, from positions and weather reports to messages.",
      "Long Lines stores every packet on the full feed for about two days, archives it after that, and counts every packet in Stats.",
      "A connection gets APRS-IS spots only for the stations it names, by callsign or callsign group. Position, Mic-E, object and item packets become spots, at most one per station every 15 minutes. A spot has no frequency, band or mode, and its comment is the packet as sent. APRS-IS spots are not on profiles.",
    ],
    showsUp: [
      "Stats: APRS-IS packets, stations, igates and packet types",
      "Connection filters: Callsigns or Callsign groups (required)",
      "Not on profiles",
    ],
    schema: deliveredSchema("aprs", {
      time: { description: "When Long Lines received the packet: ISO 8601 in UTC, whole seconds. Or Unix seconds." },
      callsign: { description: "Callsign that sent the packet, SSID included." },
      frequency_khz: noValue("APRS-IS"),
      mode: noValue("APRS-IS"),
      band: noValue("APRS-IS"),
      reference: noValue("APRS-IS"),
      place_name: noValue("APRS-IS"),
      state: noValue("APRS-IS"),
      spotter: { description: "Callsign of the igate that heard the packet on the air. Left out when the packet reached APRS-IS over the internet." },
      url: noValue("APRS-IS"),
      comment: { description: "The packet's information field as sent, such as a position report (=3546.10N/07838.35W>). Not sent by default." },
    }),
    example: {
      id: 58161711, time: "2026-10-14T14:38:15Z", callsign: "KK4PWJ-9", source: "aprs", spotter: "N4XYZ-10",
    },
  },
  {
    id: "wwff", name: "WWFF", full: "World Wide Flora & Fauna", status: "live", interval: "every 60s", pollSeconds: 60, desc: "Reference activation spots from spots.wwff.co", alerts: true,
    volume: "standard", title: "WWFF", tagline: "Activators in nature reserves and protected areas around the world.",
    mark: "WW", markColor: "success", statsKey: "wwff", site: "wwff.co", via: null,
    runBy: { operator: "World Wide Flora & Fauna", feed: "Spot list, polled every 60 seconds", modes: "CW, SSB, digital" },
    about: [
      "World Wide Flora & Fauna is an award program for portable operation from nature reserves and protected areas. Activators and hunters post spots to the WWFF spotting page as they operate.",
      "Long Lines stores every WWFF spot, keeps the reference and its name, and shows them on profiles and in Stats. Only connections that pick WWFF get them.",
    ],
    showsUp: [
      "Callsign profile: last heard, references, activity",
      "Stats: top WWFF programs, most spotted parks, summits and WWFF references",
      "Connection filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("wwff", {
      reference: { description: "WWFF reference." },
      place_name: { description: "Reference name." },
      state: noValue("WWFF"),
      url: { description: "The reference's entry in the WWFF directory. Not sent by default." },
    }),
    example: {
      id: 58161488, time: "2026-10-14T14:33:20Z", callsign: "KK4PWJ", frequency_khz: 14244, mode: "ssb", band: "20m",
      source: "wwff", reference: "KFF-5268", place_name: "T.M. Goodwin", spotter: "K3XYZ",
    },
  },
  {
    id: "wwbota", name: "WWBOTA", full: "Worldwide Bunkers on the Air", status: "live", interval: "every 60s", pollSeconds: 60, desc: "Bunker activation spots from api.wwbota.net", alerts: true,
    volume: "standard", title: "WWBOTA", tagline: "Activators at Cold War and WW2 bunkers around the world.",
    mark: "WB", markColor: "error", statsKey: "wwbota", site: "wwbota.net", via: null,
    runBy: { operator: "Worldwide Bunkers on the Air", feed: "Spot list, polled every 60 seconds", modes: "CW, SSB, FM, digital" },
    about: [
      "Worldwide Bunkers on the Air is an award program for portable operation from bunkers, from WW2 pillboxes to Cold War observation posts. Activators and hunters post spots to the WWBOTA spotting page as they operate, and one spot can name several bunkers.",
      "Long Lines stores every WWBOTA spot, keeps all of its bunker references and the first bunker's name, and shows them on profiles. Only connections that pick WWBOTA get them.",
    ],
    showsUp: [
      "Callsign profile: last heard, references, activity",
      "Connection filters: Bands, Modes, Callsigns, Callsign groups, Park, summit, or location contains",
    ],
    schema: deliveredSchema("wwbota", {
      reference: { description: "Bunker references, comma separated." },
      place_name: { description: "Name of the first bunker." },
      state: noValue("WWBOTA"),
      url: noValue("WWBOTA"),
    }),
    example: {
      id: 58161533, time: "2026-10-14T14:35:02Z", callsign: "KK4PWJ/P", frequency_khz: 7138, mode: "ssb", band: "40m",
      source: "wwbota", reference: "B/EA-0103, B/EA-0104, B/EA-0105", place_name: "Búnker 1 del Cerro de los Ángeles", spotter: "EA4IYL",
    },
  },
  {
    id: "iota", name: "IOTA", full: "Islands on the Air", status: "live", interval: "streaming", pollSeconds: 60, desc: "Island references in DX Cluster spots", alerts: true,
    volume: "standard", title: "IOTA", tagline: "Island activations, read from DX Cluster spots.",
    mark: "IO", markColor: "primary", statsKey: "iota", site: "www.iota-world.org", via: "dxcluster",
    runBy: { operator: "IOTA Ltd (iota-world.org)", feed: "DX Cluster spots that name an IOTA reference", modes: "CW, SSB, digital" },
    about: [
      "Islands on the Air is an award program for operating from the world's island groups, each with a reference such as EU-005. IOTA has no spot feed of its own: activators are spotted on the DX Cluster with the reference in the comment.",
      "Long Lines reads the reference out of every DX Cluster spot and names the island group from the IOTA list, refreshed monthly. To get these spots, make a DX Cluster connection with an IOTA island rule.",
    ],
    showsUp: [
      "Callsign profile: last heard, references, activity",
      "Connection filters: IOTA island, Park, summit, or location contains",
    ],
    schema: deliveredSchema("dxcluster", {
      reference: { description: "IOTA reference." },
      place_name: { description: "Island group name." },
      state: noValue("DX Cluster"),
      url: noValue("DX Cluster"),
    }),
    example: {
      id: 58161602, time: "2026-10-14T14:36:10Z", callsign: "HF0POL", frequency_khz: 14025, mode: "cw", band: "20m",
      source: "dxcluster", reference: "AN-010", place_name: "South Shetland Islands", spotter: "K1ABC",
    },
  },
  {
    id: "logged", name: "Logged contacts", full: "Long Lines Relay", status: "live", interval: "as they are logged", pollSeconds: null, desc: "Contacts operators log, posted by Long Lines Relay", alerts: true,
    volume: "standard", title: "Logged contacts", tagline: "Contacts operators log, posted from their logging software as they log them.",
    mark: "LC", markColor: "secondary", statsKey: "logged", site: null, via: null,
    runBy: { operator: "Long Lines operators, through Long Lines Relay", feed: "Contacts posted from logging software as they are logged", modes: "Any, as logged" },
    about: [
      "Long Lines Relay is a desktop app that catches the contacts your logging software broadcasts and posts each one to Long Lines as a spot. The operator who logged the contact is the spotter, and the station worked is the callsign.",
      "Long Lines stores every logged contact and shows them on profiles. A contact edited in the logger replaces its spot, and a deleted one is taken down. Only connections that pick Logged contacts get them.",
    ],
    showsUp: [
      "Callsign profile: last heard, activity",
      "Connection filters: Bands, Modes, Callsigns, Callsign groups",
    ],
    schema: deliveredSchema("logged", {
      callsign: { description: "Callsign of the station worked, as logged." },
      spotter: { description: "Callsign of the operator who logged the contact, as logged." },
      mode: { description: "Operating mode as logged, lower case." },
      time: { description: "When the contact was logged: ISO 8601 in UTC, whole seconds. Or Unix seconds." },
      reference: noValue("logged contact"),
      place_name: noValue("logged contact"),
      state: noValue("logged contact"),
      url: noValue("logged contact"),
      comment: noValue("logged contact"),
    }),
    example: {
      id: 58161655, time: "2026-10-14T14:37:00Z", callsign: "W1AW", frequency_khz: 14025, mode: "cw", band: "20m",
      source: "logged", spotter: "KK4PWJ",
    },
  },
];

/** A live source by id, for /sources/:id; planned and unknown ids give undefined. */
export function findLiveSource(id: string | undefined): SourceInfo | undefined {
  return SOURCES.find((s) => s.id === id && s.status === "live");
}

/**
 * Sources a new connection can start from: live and alerting. A carried source (IOTA) starts a connection on
 * its carrier with the rule that picks its spots (`blankSub`).
 */
export const LIVE_SOURCES = SOURCES.filter((s) => s.status === "live" && s.alerts);

/** The source whose ingest health stands for this one: its carrier, else itself. */
export function healthId(source: SourceInfo): string {
  return source.via ?? source.id;
}

export function sourceName(id: string): string {
  return SOURCES.find((s) => s.id === id)?.name ?? id;
}

export const BANDS = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"];
export const MODES = ["digital", "cw", "ssb", "fm", "am", "ft8", "ft4", "rtty", "psk"];

/** "digital" is a mode family (see _shared/modes.ts); everything else is a specific mode. */
export function modeLabel(m: string): string {
  return m === "digital" ? "Any digital" : m.toUpperCase();
}
