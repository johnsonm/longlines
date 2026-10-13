export interface TimePrefs {
  utcTimes: boolean;
  timezone: string;
}

/** "12s ago", "3m ago", "2h ago", "5d ago"; "never" for null. */
export function relativeAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "never";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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
  const minutes = Math.max(1, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 1440 ? [Math.floor(minutes / 60), "hour"] : [Math.floor(minutes / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
