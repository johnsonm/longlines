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

// The same list is in is_private_host() in SQL; change both together.
const PRIVATE_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24", // IETF protocol assignments
  "192.168.0.0/16",
  "198.18.0.0/15", // benchmarking
  "224.0.0.0/3", // multicast, reserved (240/4) and broadcast
];

function isPrivateIpv4(value: number): boolean {
  return PRIVATE_IPV4.some((cidr) => inIpv4Range(value, cidr));
}

/** The IPv4 address in four bytes of an IPv6 address, as a number. */
function ipv4At(b: readonly number[], at: number): number {
  return (b[at] ?? 0) * 16777216 + (b[at + 1] ?? 0) * 65536 + (b[at + 2] ?? 0) * 256 +
    (b[at + 3] ?? 0);
}

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

/**
 * True for loopback, private, link-local, CGNAT, unspecified, multicast and
 * other special-purpose addresses, and for IPv6 forms that embed a private
 * IPv4 (mapped, compatible, NAT64, 6to4). The same rules are is_private_host()
 * in SQL; change both together.
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) return isPrivateIpv4(v4);
  const b = parseIpv6(ip);
  if (b === null) return true; // not an address we understand: refuse
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible, which also covers :: and
  // ::1) and 64:ff9b::a.b.c.d (NAT64): judge the embedded IPv4.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(ipv4At(b, 12));
  if (zeros(0, 12)) return isPrivateIpv4(ipv4At(b, 12)); // :: and ::1 are in 0.0.0.0/8
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zeros(4, 12)) return isPrivateIpv4(ipv4At(b, 12));
    if (b[4] === 0x00 && b[5] === 0x01) return true; // 64:ff9b:1::/48, local-use NAT64
  }
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIpv4(ipv4At(b, 2)); // 2002::/16, 6to4
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return true; // 100::/64, discard
  if (((b[0] ?? 0) & 0xfe) === 0xfc) return true; // fc00::/7
  if ((b[0] ?? 0) === 0xfe && (((b[1] ?? 0) & 0x80) === 0x80)) return true; // fe80::/10, fec0::/10
  if (b[0] === 0xff) return true; // ff00::/8, multicast
  return false;
}

/** Hostname without IPv6 brackets or trailing dots (all of them, like SQL's rtrim), lowercase. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
}

// Name suffixes that only ever resolve inside a private network: Fly's 6PN
// (.internal, .flycast), mDNS and home networks (.local, .localdomain,
// .home.arpa) and the rest of .arpa. The same list is in
// validate_destination_url() in SQL; change both together. The sender runs
// on Fly, so a webhook at *.internal would reach another Fly app.
const DENIED_HOST_SUFFIXES = [
  ".internal",
  ".flycast",
  ".local",
  ".localdomain",
  ".home.arpa",
  ".arpa",
];

/** True for localhost names and names under a private-only suffix. */
export function isDeniedHostname(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") ||
    DENIED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
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
    parsed.username !== "" || parsed.password !== "" || isDeniedHostname(host) ||
    (isIpLiteral(host) && isPrivateIp(host))
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
 * Refuse a hostname that resolves to any private address, and return the
 * addresses it checked: the webhook connects to one of those (pinned_http.ts),
 * never to a second resolution of the name, which DNS rebinding could point
 * at an internal address. IP literals were already judged by
 * assertSafeDestinationUrl and come back as themselves. Fails closed when the
 * runtime cannot resolve DNS at all; the destination's last_error then says so.
 */
export async function assertSafeResolvedHost(
  host: string,
  resolve: Resolver = defaultResolver,
): Promise<string[]> {
  if (isIpLiteral(host)) return [host];
  const addresses = await resolve(host);
  if (addresses === null) {
    // Fail closed: without DNS we cannot rule out a private address.
    throw new Error("DNS resolution is unavailable in this runtime; webhook not sent");
  }
  if (addresses.length === 0) throw new Error(`${host} did not resolve`);
  if (addresses.some(isPrivateIp)) throw new Error(`${host} resolves to a private address`);
  return addresses;
}
