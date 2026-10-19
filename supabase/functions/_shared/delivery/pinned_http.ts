// Minimal HTTP/1.1 POST over a connection to an address the caller already
// checked. fetch() resolves the hostname again, so a TTL-0 DNS answer could
// pass the private-address check with a public IP and then send the request to
// 127.0.0.1 (DNS rebinding). Here the TCP connection goes to the checked
// address and TLS uses the URL's hostname for SNI and certificate
// verification, so nothing is resolved twice. Deno's fetch has no resolver
// hook, hence this client. No redirects are followed: a 3xx is just a status.
// One request per connection (Connection: close); the response body is read
// only as far as its framing says, capped, and discarded.

/**
 * Request headers, written in order after Host. Pairs keep their order
 * whatever the names; an object would move an integer-like name first.
 */
export type PinnedHeaders =
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [string, string]>;

export interface PinnedPostInit {
  headers: PinnedHeaders;
  body: Uint8Array | string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra PEM trust anchors; tests use a local CA. */
  caCerts?: string[];
  /** Tests and local development only: allow an http: URL over plain TCP. */
  allowInsecure?: boolean;
}

/**
 * The TCP connection to the address failed (refused, unreachable), so nothing
 * was sent and the caller may try another checked address.
 */
export class PinnedConnectError extends Error {
  override name = "PinnedConnectError";
}

export interface PinnedResponse {
  status: number;
  headers: Headers;
}

/** Status line plus headers, including any 1xx interim responses. */
export const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;
/** Body bytes read (and discarded) before the connection is closed anyway. */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
const MAX_CHUNK_LINE_BYTES = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Framing headers come from this client, never from the caller.
const RESERVED_HEADERS = ["host", "content-length", "connection", "transfer-encoding"];

interface Stream {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

/** Buffered reads over a stream, counting every byte taken from it. */
class Reader {
  #buf = new Uint8Array(0);
  #eof = false;
  constructor(readonly stream: Stream) {}

  get buffered(): Uint8Array {
    return this.#buf;
  }

  /** Reads more into the buffer; false at end of stream. */
  async fill(): Promise<boolean> {
    if (this.#eof) return false;
    const chunk = new Uint8Array(16 * 1024);
    const n = await this.stream.read(chunk);
    if (n === null) {
      this.#eof = true;
      return false;
    }
    const next = new Uint8Array(this.#buf.length + n);
    next.set(this.#buf);
    next.set(chunk.subarray(0, n), this.#buf.length);
    this.#buf = next;
    return true;
  }

  consume(n: number): Uint8Array {
    const taken = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return taken;
  }
}

/** Index just past the blank line that ends a head, or -1 when not yet buffered. */
function headEnd(buf: Uint8Array): number {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    if (buf[i + 1] === 0x0a) return i + 2;
    if (buf[i + 1] === 0x0d && buf[i + 2] === 0x0a) return i + 3;
  }
  return -1;
}

/**
 * Head bytes as a string, one character per byte (ISO-8859-1 proper, which is
 * what a ByteString is). Not TextDecoder("latin1"): that is windows-1252 and
 * maps 0x80-0x9f elsewhere.
 */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    text += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return text;
}

/**
 * The status line must parse; a header line that does not (no colon, a bad
 * name, a value Headers refuses) is skipped rather than thrown on. Only
 * retry-after, content-length and transfer-encoding are ever read, and a
 * receiver whose framework adds an odd header has still taken the delivery:
 * failing its 2xx would send the batch again.
 */
function parseHead(text: string): PinnedResponse {
  const lines = text.split(/\r?\n/);
  const status = /^HTTP\/1\.[01] ([1-9]\d\d)(?: .*)?$/.exec(lines[0] ?? "");
  if (!status) throw new Error("malformed HTTP status line");
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    if (/^[ \t]/.test(line)) throw new Error("folded HTTP response header");
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon) : "";
    if (!TOKEN.test(name)) continue;
    try {
      headers.append(name, line.slice(colon + 1).trim());
    } catch {
      // a value Headers refuses (NUL, say): not one this client reads
    }
  }
  return { status: Number(status[1]), headers };
}

/** Reads response heads until a final (non-1xx) one. */
async function readResponseHead(reader: Reader): Promise<PinnedResponse> {
  let headBytes = 0;
  for (;;) {
    let end = headEnd(reader.buffered);
    while (end < 0) {
      if (headBytes + reader.buffered.length > MAX_RESPONSE_HEAD_BYTES) {
        throw new Error(`response headers exceed ${MAX_RESPONSE_HEAD_BYTES} bytes`);
      }
      if (!(await reader.fill())) throw new Error("connection closed before the response");
      end = headEnd(reader.buffered);
    }
    headBytes += end;
    if (headBytes > MAX_RESPONSE_HEAD_BYTES) {
      throw new Error(`response headers exceed ${MAX_RESPONSE_HEAD_BYTES} bytes`);
    }
    const response = parseHead(latin1(reader.consume(end)));
    if (response.status >= 200) return response;
    if (response.status === 101) throw new Error("unexpected HTTP 101 response");
  }
}

/** Discards up to MAX_RESPONSE_BODY_BYTES of body, stopping where the framing ends. */
async function drainBody(reader: Reader, response: PinnedResponse): Promise<void> {
  if (response.status === 204 || response.status === 304) return;
  let budget = MAX_RESPONSE_BODY_BYTES;
  const skip = async (n: number): Promise<boolean> => {
    let left = n;
    while (left > 0) {
      if (reader.buffered.length === 0 && !(await reader.fill())) return false;
      const take = Math.min(left, reader.buffered.length, budget);
      if (take === 0) return false; // over budget
      reader.consume(take);
      left -= take;
      budget -= take;
    }
    return true;
  };
  const line = async (): Promise<string | null> => {
    for (;;) {
      const lf = reader.buffered.indexOf(0x0a);
      if (lf >= 0) {
        if (lf + 1 > budget) return null;
        budget -= lf + 1;
        return decoder.decode(reader.consume(lf + 1)).replace(/\r?\n$/, "");
      }
      if (reader.buffered.length > Math.min(MAX_CHUNK_LINE_BYTES, budget)) return null;
      if (!(await reader.fill())) return null;
    }
  };

  const transferEncoding = response.headers.get("transfer-encoding");
  if (transferEncoding !== null && /(^|,)\s*chunked\s*$/i.test(transferEncoding)) {
    for (;;) {
      const sizeLine = await line();
      if (sizeLine === null) return;
      const size = /^([0-9a-fA-F]{1,8})[ \t]*(;.*)?$/.exec(sizeLine);
      if (!size) return;
      const n = parseInt(size[1]!, 16);
      if (n === 0) break;
      if (!(await skip(n)) || (await line()) !== "") return;
    }
    // Trailers, up to the blank line.
    for (;;) {
      const trailer = await line();
      if (trailer === null || trailer === "") return;
    }
  }
  const length = response.headers.get("content-length");
  if (length !== null) {
    if (/^\d+$/.test(length)) await skip(Number(length));
    return;
  }
  await skip(budget); // until close or the cap
}

function requestHead(url: URL, headers: PinnedHeaders, length: number): string {
  const lines = [`POST ${url.pathname || "/"}${url.search} HTTP/1.1`, `Host: ${url.host}`];
  const pairs = Array.isArray(headers)
    ? headers as ReadonlyArray<readonly [string, string]>
    : Object.entries(headers);
  for (const [name, value] of pairs) {
    if (!TOKEN.test(name)) throw new Error(`invalid request header name ${JSON.stringify(name)}`);
    if (/[\r\n\0]/.test(value)) throw new Error(`invalid value for request header ${name}`);
    if (RESERVED_HEADERS.includes(name.toLowerCase())) {
      throw new Error(`request header ${name} is set by the client`);
    }
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Content-Length: ${length}`, "Connection: close", "", "");
  return lines.join("\r\n");
}

async function writeAll(stream: Stream, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) offset += await stream.write(bytes.subarray(offset));
}

/**
 * POSTs to `url` over a connection to `address` (an IPv4 or IPv6 literal the
 * caller has already judged safe), verifying TLS against the URL's hostname.
 * Only with `allowInsecure` may `address` be a name, which Deno.connect resolves.
 * Resolves with the final status and headers; throws on any transport,
 * protocol, timeout or abort error. Credentials in the URL are refused, as
 * fetch() refuses them.
 */
export async function pinnedPost(
  url: URL,
  address: string,
  init: PinnedPostInit,
): Promise<PinnedResponse> {
  const tls = url.protocol === "https:";
  if (!tls && !(url.protocol === "http:" && init.allowInsecure)) {
    throw new Error("Use an https URL.");
  }
  if (url.username !== "" || url.password !== "") throw new Error("URL has credentials");
  const port = url.port === "" ? (tls ? 443 : 80) : Number(url.port);
  const hostname = address.replace(/^\[|\]$/g, "");
  const body = typeof init.body === "string" ? encoder.encode(init.body) : init.body;
  const head = encoder.encode(requestHead(url, init.headers, body.length));
  const request = new Uint8Array(head.length + body.length);
  request.set(head);
  request.set(body, head.length);

  const timeout = AbortSignal.timeout(init.timeoutMs);
  const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
  let stream: Stream | null = null;
  let closed = false;
  const close = () => {
    if (closed || stream === null) return;
    closed = true;
    try {
      stream.close();
    } catch {
      // already closed by the peer
    }
  };
  const abortError = () =>
    timeout.aborted ? new Error(`timed out after ${init.timeoutMs} ms`) : new Error("aborted");
  // Aborting closes the connection, which fails whichever read or write is pending.
  const onAbort = () => close();
  if (signal.aborted) throw abortError();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const connected = Deno.connect({ hostname, port });
    // Deno.connect takes no signal; race it, and close a connection that lands late.
    const tcp = await new Promise<Deno.TcpConn>((resolve, reject) => {
      const late = () => reject(abortError());
      signal.addEventListener("abort", late, { once: true });
      connected.then(
        (conn) => {
          signal.removeEventListener("abort", late);
          if (signal.aborted) {
            conn.close();
            reject(abortError());
          } else resolve(conn);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", late);
          reject(new PinnedConnectError(error instanceof Error ? error.message : String(error)));
        },
      );
    });
    stream = tcp;
    if (tls) {
      const tlsConn = await Deno.startTls(tcp, {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        caCerts: init.caCerts,
        alpnProtocols: ["http/1.1"],
      });
      stream = tlsConn;
      await tlsConn.handshake();
    }
    await writeAll(stream, request);
    const reader = new Reader(stream);
    const response = await readResponseHead(reader);
    try {
      await drainBody(reader, response);
    } catch {
      // The status is already known; a body that breaks off changes nothing.
    }
    return response;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    signal.removeEventListener("abort", onAbort);
    close();
  }
}
