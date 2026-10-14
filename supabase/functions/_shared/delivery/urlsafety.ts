// Outbound URL safety for webhooks, mirroring validate_destination_url() in
// SQL and adding a DNS check so a hostname cannot be pointed at an internal
// address after it was accepted.

export type Resolver = (host: string) => Promise<string[] | null>;

function parseIpv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets.reduce((acc, o) => acc * 256 + o, 0);
}

function inIpv4Range(value: number, cidr: string): boolean {
  const [base, bitsText] = cidr.split("/");
  const baseValue = parseIpv4(base ?? "");
  const bits = Number(bitsText);
  if (baseValue === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
}

const PRIVATE_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
];

/** The 16 bytes of an IPv6 address, or null when it does not parse. */
function parseIpv6(ip: string): number[] | null {
  let text = ip.trim();
  // Embedded IPv4 (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (v4) {
    const value = parseIpv4(v4[2] ?? "");
    if (value === null) return null;
    text = `${v4[1]}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  return bytes;
}

export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

/** True for loopback, private, link-local, CGNAT, unspecified and IPv4-mapped addresses. */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return PRIVATE_IPV4.some((cidr) => inIpv4Range(v4, cidr));
  const b = parseIpv6(ip);
  if (b === null) return true; // not an address we understand: refuse
  const allZeroPrefix = b.slice(0, 10).every((x) => x === 0);
  if (allZeroPrefix && b[10] === 0xff && b[11] === 0xff) {
    // ::ffff:a.b.c.d — judge the embedded IPv4
    const v4Value = ((b[12] ?? 0) * 16777216) + ((b[13] ?? 0) * 65536) + ((b[14] ?? 0) * 256) +
      (b[15] ?? 0);
    return PRIVATE_IPV4.some((cidr) => inIpv4Range(v4Value, cidr));
  }
  if (b.slice(0, 15).every((x) => x === 0) && ((b[15] ?? 0) === 0 || (b[15] ?? 0) === 1)) {
    return true; // :: and ::1
  }
  if (((b[0] ?? 0) & 0xfe) === 0xfc) return true; // fc00::/7
  if ((b[0] ?? 0) === 0xfe && (((b[1] ?? 0) & 0xc0) === 0x80)) return true; // fe80::/10
  return false;
}

/** Hostname without IPv6 brackets, lowercase. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Throws with a user-facing message when the URL must not be used for the type. */
export function assertSafeDestinationUrl(type: "discord" | "webhook", url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Use an https URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("Use an https URL.");
  const host = hostOf(parsed);
  if (type === "discord") {
    if (
      !["discord.com", "discordapp.com"].includes(host) ||
      !parsed.pathname.startsWith("/api/webhooks/")
    ) {
      throw new Error("Use a Discord webhook URL.");
    }
    return parsed;
  }
  if (
    host === "localhost" || host.endsWith(".localhost") || (isIpLiteral(host) && isPrivateIp(host))
  ) {
    throw new Error("That address is not allowed.");
  }
  return parsed;
}

// Browser push services. The same list is validate_push_endpoint() in SQL;
// change both together. Suffixes keep their leading dot, so
// evilpush.apple.com does not pass as a push.apple.com subdomain.
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

/**
 * Throws unless the URL is https on a known push-service host, with no port
 * or credentials. Push endpoints come from the browser, so this is the SSRF
 * guard for push delivery.
 */
export function assertSafePushEndpoint(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Use a browser push service.");
  }
  const host = hostOf(parsed);
  if (
    parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "" ||
    parsed.password !== "" ||
    !(PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  ) {
    throw new Error("Use a browser push service.");
  }
  return parsed;
}

/** Resolves A and AAAA records. Null when the runtime cannot resolve DNS at all. */
export const defaultResolver: Resolver = async (host) => {
  if (typeof Deno.resolveDns !== "function") return null;
  const lookups = await Promise.allSettled([
    Deno.resolveDns(host, "A"),
    Deno.resolveDns(host, "AAAA"),
  ]);
  const addresses = lookups.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return addresses;
};

/**
 * Refuse a hostname that resolves to any private address. IP literals were
 * already judged by assertSafeDestinationUrl and are not resolved again.
 * Fails closed when the runtime cannot resolve DNS at all; the destination's
 * last_error then says so.
 */
export async function assertSafeResolvedHost(
  host: string,
  resolve: Resolver = defaultResolver,
): Promise<void> {
  if (isIpLiteral(host)) return;
  const addresses = await resolve(host);
  if (addresses === null) {
    // Fail closed: without DNS we cannot rule out a private address.
    throw new Error("DNS resolution is unavailable in this runtime; webhook not sent");
  }
  if (addresses.length === 0) throw new Error(`${host} did not resolve`);
  if (addresses.some(isPrivateIp)) throw new Error(`${host} resolves to a private address`);
}
