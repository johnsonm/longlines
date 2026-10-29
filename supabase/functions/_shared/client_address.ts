// A client address as a rate limit counts it: an IPv4 address, or an IPv6 address's /64, since
// one host usually holds the whole prefix and could otherwise take a fresh limit for every
// address in it. No dependencies: the callsign-profile family of functions and the sender's
// spots stream (sender/cluster_stream.ts, whose image maps only postgres and zod) both load it.

function ipv4Octets(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) {
    return null;
  }
  const octets = parts.map(Number);
  if (octets.every((o) => o <= 255)) {
    return octets;
  }
  return null;
}

/** The number at index i, or 0 when there is none. */
function numberAt(values: number[], i: number): number {
  const value = values[i];
  if (value === undefined) {
    return 0;
  }
  return value;
}

/** The colon-separated groups of one side of "::"; none for a missing or empty side. */
function splitGroups(half: string | undefined): string[] {
  if (half === undefined || half === "") {
    return [];
  }
  return half.split(":");
}

function ipv6Groups(text: string): number[] | null {
  let s = text.toLowerCase();
  // An embedded IPv4 tail (::ffff:192.0.2.1) is the last two groups.
  const tailMatch = /:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let tail: string | undefined;
  if (tailMatch !== null) {
    tail = tailMatch[1];
  }
  if (tail !== undefined && tail !== "") {
    const o = ipv4Octets(tail);
    if (o === null) {
      return null;
    }
    const a = numberAt(o, 0);
    const b = numberAt(o, 1);
    const c = numberAt(o, 2);
    const d = numberAt(o, 3);
    s = `${s.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = splitGroups(halves[0]);
  const rest = splitGroups(halves[1]);
  if (!head.concat(rest).every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1) {
    if (missing !== 0) {
      return null;
    }
  } else if (missing < 1) {
    return null;
  }
  let zeroCount = 0;
  if (halves.length === 2) {
    zeroCount = missing;
  }
  const zeros = Array<string>(zeroCount).fill("0");
  return head.concat(zeros, rest).map((g) => parseInt(g, 16));
}

/**
 * What the rate limit counts: an IPv4 address, or an IPv6 address's /64
 * ("2001:db8:0:1::/64"); an IPv4-mapped IPv6 address counts as its IPv4
 * address. Accepts a port on IPv4, and brackets, a port and a zone on IPv6.
 * Null when the value is not an address.
 */
export function rateLimitSubject(raw: string): string | null {
  const value = raw.trim();
  const v4 = ipv4Octets(value.replace(/:\d+$/, ""));
  if (v4 !== null) {
    return v4.join(".");
  }
  const groups = ipv6Groups(value.replace(/^\[(.*)\](:\d+)?$/, "$1").replace(/%.*$/, ""));
  if (groups === null) {
    return null;
  }
  const a = groups[0];
  const b = groups[1];
  const c = groups[2];
  const d = groups[3];
  const e = groups[4];
  const f = groups[5];
  const g = numberAt(groups, 6);
  const h = numberAt(groups, 7);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [g >> 8, g & 255, h >> 8, h & 255].join(".");
  }
  return `${groups.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}
