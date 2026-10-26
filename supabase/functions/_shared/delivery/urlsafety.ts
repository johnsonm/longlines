// Outbound URL safety for webhooks, mirroring validate_destination_url() in
// SQL and adding a DNS check so a hostname cannot be pointed at an internal
// address after it was accepted.

import type { ErrorContext } from "../errors.ts";

/**
 * A destination URL, push endpoint or resolved address failed a check here. The
 * message is user-facing: it becomes the destination's or the device's last error.
 */
export class UnsafeUrlError extends Error {
  override readonly name = "UnsafeUrlError";

  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
  }
}

export type Resolver = (host: string) => Promise<string[] | null>;

function parseIpv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) {
    return null;
  }
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) {
    return null;
  }
  let value = 0;
  for (const o of octets) {
    value = value * 256 + o;
  }
  return value;
}

function inIpv4Range(value: number, cidr: string): boolean {
  const parts = cidr.split("/");
  const base = parts[0];
  const bitsText = parts[1];
  let baseText = "";
  if (base !== undefined) {
    baseText = base;
  }
  const baseValue = parseIpv4(baseText);
  const bits = Number(bitsText);
  if (baseValue === null) {
    return false;
  }
  let mask = 0;
  if (bits !== 0) {
    mask = (0xffffffff << (32 - bits)) >>> 0;
  }
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

/** The byte at an index, or 0 past the end. */
function byteAt(b: readonly number[], at: number): number {
  const value = b[at];
  if (value === undefined) {
    return 0;
  }
  return value;
}

/** The IPv4 address in four bytes of an IPv6 address, as a number. */
function ipv4At(b: readonly number[], at: number): number {
  return byteAt(b, at) * 16777216 + byteAt(b, at + 1) * 65536 + byteAt(b, at + 2) * 256 +
    byteAt(b, at + 3);
}

/** True when every byte from `from` up to `to` is zero. */
function zerosIn(b: readonly number[], from: number, to: number): boolean {
  return b.slice(from, to).every((x) => x === 0);
}

/** The 16 bytes of an IPv6 address, or null when it does not parse. */
function parseIpv6(ip: string): number[] | null {
  let text = ip.trim();
  // Embedded IPv4 (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (v4 !== null) {
    let v4Text = "";
    const embedded = v4[2];
    if (embedded !== undefined) {
      v4Text = embedded;
    }
    const value = parseIpv4(v4Text);
    if (value === null) {
      return null;
    }
    text = `${String(v4[1])}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const first = halves[0];
  let head: string[] = [];
  if (first !== undefined && first !== "") {
    head = first.split(":");
  }
  const second = halves[1];
  let tail: string[] = [];
  if (halves.length === 2 && second !== undefined && second !== "") {
    tail = second.split(":");
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  const groups = head.concat(Array<string>(missing).fill("0"), tail);
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      return null;
    }
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
  if (v4 !== null) {
    return isPrivateIpv4(v4);
  }
  const b = parseIpv6(ip);
  if (b === null) {
    // not an address we understand: refuse
    return true;
  }
  // ::ffff:a.b.c.d (mapped), ::a.b.c.d (compatible, which also covers :: and
  // ::1) and 64:ff9b::a.b.c.d (NAT64): judge the embedded IPv4.
  if (zerosIn(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIpv4(ipv4At(b, 12));
  }
  if (zerosIn(b, 0, 12)) {
    // :: and ::1 are in 0.0.0.0/8
    return isPrivateIpv4(ipv4At(b, 12));
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zerosIn(b, 4, 12)) {
      return isPrivateIpv4(ipv4At(b, 12));
    }
    if (b[4] === 0x00 && b[5] === 0x01) {
      // 64:ff9b:1::/48, local-use NAT64
      return true;
    }
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    // 2002::/16, 6to4
    return isPrivateIpv4(ipv4At(b, 2));
  }
  if (b[0] === 0x01 && b[1] === 0x00 && zerosIn(b, 2, 8)) {
    // 100::/64, discard
    return true;
  }
  if ((byteAt(b, 0) & 0xfe) === 0xfc) {
    // fc00::/7
    return true;
  }
  if (byteAt(b, 0) === 0xfe && ((byteAt(b, 1) & 0x80) === 0x80)) {
    // fe80::/10, fec0::/10
    return true;
  }
  if (b[0] === 0xff) {
    // ff00::/8, multicast
    return true;
  }
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

/** Throws UnsafeUrlError, with a user-facing message, when the URL must not be used for the type. */
export function assertSafeDestinationUrl(type: "discord" | "webhook", url: string): URL {
  if (!URL.canParse(url)) {
    throw new UnsafeUrlError("Use an https URL.", { cause: undefined });
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new UnsafeUrlError("Use an https URL.", { cause: undefined });
  }
  const host = hostOf(parsed);
  if (type === "discord") {
    if (
      !["discord.com", "discordapp.com"].includes(host) ||
      !parsed.pathname.startsWith("/api/webhooks/")
    ) {
      throw new UnsafeUrlError("Use a Discord webhook URL.", { cause: undefined });
    }
    return parsed;
  }
  if (
    parsed.username !== "" || parsed.password !== "" || isDeniedHostname(host) ||
    (isIpLiteral(host) && isPrivateIp(host))
  ) {
    throw new UnsafeUrlError("That address is not allowed.", { cause: undefined });
  }
  return parsed;
}

// Browser push services. The same list is validate_push_endpoint() in SQL;
// change both together. Suffixes keep their leading dot, so
// evilpush.apple.com does not pass as a push.apple.com subdomain.
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

/**
 * Throws UnsafeUrlError unless the URL is https on a known push-service host, with no port
 * or credentials. Push endpoints come from the browser, so this is the SSRF
 * guard for push delivery.
 */
export function assertSafePushEndpoint(url: string): URL {
  if (!URL.canParse(url)) {
    throw new UnsafeUrlError("Use a browser push service.", { cause: undefined });
  }
  const parsed = new URL(url);
  const host = hostOf(parsed);
  if (
    parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "" ||
    parsed.password !== "" ||
    !(PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
  ) {
    throw new UnsafeUrlError("Use a browser push service.", { cause: undefined });
  }
  return parsed;
}

/** Resolves A and AAAA records. Null when the runtime cannot resolve DNS at all. */
export async function defaultResolver(host: string): Promise<string[] | null> {
  if (typeof Deno.resolveDns !== "function") {
    return null;
  }
  const lookups = await Promise.allSettled([
    Deno.resolveDns(host, "A"),
    Deno.resolveDns(host, "AAAA"),
  ]);
  const addresses: string[] = [];
  for (const r of lookups) {
    if (r.status === "fulfilled") {
      for (const address of r.value) {
        addresses.push(address);
      }
    }
  }
  return addresses;
}

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
  resolve: Resolver,
): Promise<string[]> {
  if (isIpLiteral(host)) {
    return [host];
  }
  const addresses = await resolve(host);
  if (addresses === null) {
    // Fail closed: without DNS we cannot rule out a private address.
    throw new UnsafeUrlError("DNS resolution is unavailable in this runtime; webhook not sent", {
      cause: undefined,
    });
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`${host} did not resolve`, { cause: undefined });
  }
  if (addresses.some(isPrivateIp)) {
    throw new UnsafeUrlError(`${host} resolves to a private address`, { cause: undefined });
  }
  return addresses;
}
