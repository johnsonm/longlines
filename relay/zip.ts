// Reads single entries of a remote zip file without downloading the rest.
// The central directory comes from the file's tail; each entry is one HTTP
// Range request streamed through DecompressionStream, so memory stays flat
// however large the entry is. l_amat.zip is ~200 MB, of which the license
// import needs three entries.
//
// Covers what the FCC's files use: stored or deflated entries, no zip64, no
// encryption. Anything else throws.

import { userAgent } from "../supabase/functions/_shared/http.ts";
import { isLocalHost } from "./config.ts";

/** Random access to a file's bytes. */
export interface RangeSource {
  size: number;
  /** Bytes [start, end). */
  bytes(start: number, end: number): Promise<Uint8Array>;
  /** Bytes [start, end) as a stream. */
  stream(start: number, end: number): Promise<ReadableStream<Uint8Array>>;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
  /** CRC-32 of the uncompressed bytes, from the central directory. */
  crc32: number;
}

/** CRC-32 (IEEE 802.3, reflected 0xEDB88320), the checksum zip stores per entry. */
function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if ((c & 1) !== 0) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

/** Folds `bytes` into a running CRC-32; start from 0 and pass the previous result to continue. */
export function crc32(bytes: Uint8Array, previous: number): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) {
      throw new Error("crc32: byte index out of range");
    }
    const t = CRC_TABLE[(c ^ b) & 0xff];
    if (t === undefined) {
      throw new Error("crc32: table index out of range");
    }
    c = t ^ (c >>> 8);
  }
  return ~c >>> 0;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_MAX = 22 + 0xffff; // fixed part plus the longest comment

export async function readZipDirectory(src: RangeSource): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, src.size - EOCD_MAX);
  const tail = await src.bytes(tailStart, src.size);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    // The record ends the file: its comment length must reach exactly to the
    // end, which also skips the signature's bytes appearing inside a comment.
    if (view.getUint32(i, true) === EOCD && i + 22 + view.getUint16(i + 20, true) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("not a zip file: no end of central directory");
  }
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff) {
    throw new Error("zip64 is not supported");
  }

  let dir: Uint8Array;
  if (dirOffset >= tailStart) {
    dir = tail.subarray(dirOffset - tailStart, dirOffset - tailStart + dirSize);
  } else {
    dir = await src.bytes(dirOffset, dirOffset + dirSize);
  }
  const d = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > dir.length || d.getUint32(p, true) !== CENTRAL) {
      throw new Error("corrupt zip central directory");
    }
    const flags = d.getUint16(p + 8, true);
    const nameLength = d.getUint16(p + 28, true);
    const entry: ZipEntry = {
      name: new TextDecoder().decode(dir.subarray(p + 46, p + 46 + nameLength)),
      method: d.getUint16(p + 10, true),
      compressedSize: d.getUint32(p + 20, true),
      size: d.getUint32(p + 24, true),
      headerOffset: d.getUint32(p + 42, true),
      crc32: d.getUint32(p + 16, true),
    };
    if ((flags & 1) !== 0) {
      throw new Error(`${entry.name} is encrypted`);
    }
    if ([entry.compressedSize, entry.size, entry.headerOffset].includes(0xffffffff)) {
      throw new Error("zip64 is not supported");
    }
    entries.push(entry);
    p += 46 + nameLength + d.getUint16(p + 30, true) + d.getUint16(p + 32, true);
  }
  return entries;
}

/**
 * The entry's uncompressed bytes. The stream errors if they are not exactly
 * entry.size or their CRC-32 is not entry.crc32.
 */
export async function openZipEntry(
  src: RangeSource,
  entry: ZipEntry,
): Promise<ReadableStream<Uint8Array>> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`${entry.name}: compression method ${String(entry.method)} is not supported`);
  }
  const header = await src.bytes(entry.headerOffset, entry.headerOffset + 30);
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 30 || h.getUint32(0, true) !== LOCAL) {
    throw new Error(`${entry.name}: corrupt local header`);
  }
  const start = entry.headerOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const raw = await src.stream(start, start + entry.compressedSize);
  let data: ReadableStream<Uint8Array>;
  if (entry.method === 8) {
    data = raw.pipeThrough(
      new DecompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>,
    );
  } else {
    data = raw;
  }

  let seen = 0;
  let crc = 0;
  return data.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller): void {
        seen += chunk.length;
        if (seen > entry.size) {
          controller.error(new Error(`${entry.name}: more than ${String(entry.size)} bytes`));
        } else {
          crc = crc32(chunk, crc);
          controller.enqueue(chunk);
        }
      },
      flush(controller): void {
        if (seen !== entry.size) {
          controller.error(
            new Error(`${entry.name}: ${String(seen)} of ${String(entry.size)} bytes`),
          );
        } else if (crc !== entry.crc32) {
          controller.error(new Error(`${entry.name}: CRC-32 mismatch`));
        }
      },
    }),
  );
}

export interface HttpZip extends RangeSource {
  /**
   * Last-Modified, or the strong ETag when the server sends no date. This is
   * what fcc_license_load_status stores, so it stays the date when there is one
   * (switching it to the ETag would make the loaded file look new once).
   */
  version: string;
}

/** A strong entity tag (`"..."`), the only kind RFC 9110 allows in If-Range. */
function strongEtag(etag: string | null): string | null {
  let tag = "";
  if (etag !== null && etag !== undefined) {
    tag = etag.trim();
  }
  if (/^"[^"]*"$/.test(tag)) {
    return tag;
  }
  return null;
}

/** How long stream()'s Range request may wait for response headers; the body then has readWithin's idle timeout. */
export const STREAM_HEADER_TIMEOUT_MS = 60_000;

/**
 * A remote file read with Range requests. HEAD gives its size and version.
 * Every request carries the User-Agent and `signal`; a server that ignores
 * Range (answers 200) is an error rather than a full download.
 */
export async function openHttpZip(
  url: string,
  signal: AbortSignal,
  fetchFn: typeof fetch,
  streamHeaderTimeoutMs: number,
): Promise<HttpZip> {
  // The file is loaded into a public table: never over plain http, except
  // from a local server in tests and development.
  const parsed = new URL(url);
  const protocol = parsed.protocol;
  const hostname = parsed.hostname;
  if (protocol !== "https:" && !(protocol === "http:" && isLocalHost(hostname))) {
    throw new Error(`${url}: https is required outside local development`);
  }
  const headers = { "User-Agent": userAgent() };
  const head = await fetchFn(url, {
    method: "HEAD",
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (head.body !== null && head.body !== undefined) {
    await head.body.cancel();
  }
  if (!head.ok) {
    throw new Error(`HEAD ${url}: HTTP ${String(head.status)}`);
  }
  const size = Number(head.headers.get("content-length"));
  const lastModified = head.headers.get("last-modified");
  const etag = strongEtag(head.headers.get("etag"));
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`HEAD ${url}: no Content-Length`);
  }
  const noLastModified = lastModified === null || lastModified === undefined ||
    lastModified === "";
  const noEtag = etag === null || etag === undefined || etag === "";
  if (noLastModified && noEtag) {
    let message: string;
    if (head.headers.has("etag")) {
      message =
        `HEAD ${url}: only a weak ETag and no Last-Modified, so If-Range cannot pin the file`;
    } else {
      message = `HEAD ${url}: no Last-Modified or ETag`;
    }
    throw new Error(message);
  }
  let version = "";
  if (lastModified !== null && lastModified !== undefined) {
    version = lastModified;
  } else if (etag !== null && etag !== undefined) {
    version = etag;
  }
  // RFC 9110 13.1.5: send the strong entity tag when there is one, a date otherwise.
  let ifRange = "";
  if (etag !== null && etag !== undefined) {
    ifRange = etag;
  } else if (lastModified !== null && lastModified !== undefined) {
    ifRange = lastModified;
  }

  // If-Range ties every range to the version HEAD saw: if the FCC replaces the
  // file mid-load, the server answers 200 with the new file, which is refused,
  // rather than mixing two weeks' bytes.
  async function range(
    start: number,
    end: number,
    timeout: AbortSignal | undefined,
  ): Promise<Response> {
    let requestSignal = signal;
    if (timeout !== undefined) {
      requestSignal = AbortSignal.any([signal, timeout]);
    }
    const res = await fetchFn(url, {
      headers: {
        "User-Agent": headers["User-Agent"],
        Range: `bytes=${String(start)}-${String(end - 1)}`,
        "If-Range": ifRange,
      },
      signal: requestSignal,
    });
    const what = `GET ${url} bytes ${String(start)}-${String(end - 1)}`;
    if (res.status !== 206) {
      if (res.body !== null && res.body !== undefined) {
        await res.body.cancel();
      }
      throw new Error(`${what}: HTTP ${String(res.status)}, expected 206`);
    }
    // A shifted or partial range would put the wrong bytes at every offset.
    let contentRange = "";
    const contentRangeHeader = res.headers.get("content-range");
    if (contentRangeHeader !== null && contentRangeHeader !== undefined) {
      contentRange = contentRangeHeader;
    }
    if (!contentRange.startsWith(`bytes ${String(start)}-${String(end - 1)}/`)) {
      if (res.body !== null && res.body !== undefined) {
        await res.body.cancel();
      }
      throw new Error(`${what}: Content-Range "${contentRange}" does not match`);
    }
    return res;
  }

  return {
    size,
    version,
    async bytes(start, end): Promise<Uint8Array> {
      const res = await range(start, end, AbortSignal.timeout(60_000));
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.length !== end - start) {
        throw new Error(
          `GET ${url} bytes ${String(start)}-${String(end - 1)}: ${String(body.length)} of ${
            String(end - start)
          } bytes`,
        );
      }
      return body;
    },
    async stream(start, end): Promise<ReadableStream<Uint8Array>> {
      // No overall timeout: the caller reads slowly, pausing while it pushes rows.
      // Only the wait for headers is bounded; the timer is cleared once they
      // arrive, so it never aborts the body.
      const headerTimeout = new AbortController();
      function abortHeaders(): void {
        headerTimeout.abort(
          new Error(
            `GET ${url} bytes ${String(start)}-${String(end - 1)}: no response within ${
              String(streamHeaderTimeoutMs)
            } ms`,
          ),
        );
      }
      const timer = setTimeout(abortHeaders, streamHeaderTimeoutMs);
      let res: Response;
      try {
        res = await range(start, end, headerTimeout.signal);
      } finally {
        clearTimeout(timer);
      }
      if (res.body === null || res.body === undefined) {
        throw new Error(`GET ${url}: empty body`);
      }
      return res.body;
    },
  };
}
