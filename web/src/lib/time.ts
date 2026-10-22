export interface TimePrefs {
  utcTimes: boolean;
  timezone: string;
}

type AgeUnit = "second" | "minute" | "hour" | "day";

/** An age in whole seconds as a count of its largest unit, rounded down: 150 is [2, "minute"]. */
function ageBucket(seconds: number): [number, AgeUnit] {
  if (seconds < 60) return [seconds, "second"];
  if (seconds < 3600) return [Math.floor(seconds / 60), "minute"];
  if (seconds < 86400) return [Math.floor(seconds / 3600), "hour"];
  return [Math.floor(seconds / 86400), "day"];
}

/** "12s ago", "3m ago", "2h ago", "5d ago"; "never" for null. */
export function relativeAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "never";
  const [n, unit] = ageBucket(Math.max(0, Math.floor(seconds)));
  return `${n}${unit[0]} ago`;
}

/** HH:MM:SS, in UTC or the user's zone. Unknown zones fall back to UTC. */
export function formatSpotTime(iso: string, prefs: TimePrefs): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    timeZone: prefs.utcTimes ? "UTC" : prefs.timezone,
  };
  try {
    return new Intl.DateTimeFormat("en-GB", options).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(date);
  }
}

/** "Oct 5, 2026" for the account page. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

/** "1 minute ago", "3 hours ago", "5 days ago", never less than a minute, for API token rows. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const [n, unit] = ageBucket(Math.max(60, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000)));
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
