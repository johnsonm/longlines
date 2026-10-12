// Reads single entries of a remote zip file without downloading the rest.
// The central directory comes from the file's tail; each entry is one HTTP
// Range request streamed through DecompressionStream, so memory stays flat
// however large the entry is. l_amat.zip is ~200 MB, of which the license
// import needs three entries.
//
// Covers what the FCC's files use: stored or deflated entries, no zip64, no
// encryption. Anything else throws.

import { userAgent } from "../supabase/functions/_shared/http.ts";

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
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file: no end of central directory");
  const count = view.getUint16(eocd + 10, true);
  const dirSize = view.getUint32(eocd + 12, true);
  const dirOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error("zip64 is not supported");

  const dir = dirOffset >= tailStart
    ? tail.subarray(dirOffset - tailStart, dirOffset - tailStart + dirSize)
    : await src.bytes(dirOffset, dirOffset + dirSize);
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
    };
    if (flags & 1) throw new Error(`${entry.name} is encrypted`);
    if ([entry.compressedSize, entry.size, entry.headerOffset].includes(0xffffffff)) {
      throw new Error("zip64 is not supported");
    }
    entries.push(entry);
    p += 46 + nameLength + d.getUint16(p + 30, true) + d.getUint16(p + 32, true);
  }
  return entries;
}

/** The entry's uncompressed bytes. The stream errors if they are not exactly entry.size. */
export async function openZipEntry(
  src: RangeSource,
  entry: ZipEntry,
): Promise<ReadableStream<Uint8Array>> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`${entry.name}: compression method ${entry.method} is not supported`);
  }
  const header = await src.bytes(entry.headerOffset, entry.headerOffset + 30);
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 30 || h.getUint32(0, true) !== LOCAL) {
    throw new Error(`${entry.name}: corrupt local header`);
  }
  const start = entry.headerOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const raw = await src.stream(start, start + entry.compressedSize);
  const data = entry.method === 8
    ? raw.pipeThrough(
      new DecompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>,
    )
    : raw;

  let seen = 0;
  return data.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.length;
        if (seen > entry.size) {
          controller.error(new Error(`${entry.name}: more than ${entry.size} bytes`));
        } else controller.enqueue(chunk);
      },
      flush(controller) {
        if (seen !== entry.size) {
          controller.error(new Error(`${entry.name}: ${seen} of ${entry.size} bytes`));
        }
      },
    }),
  );
}

export interface HttpZip extends RangeSource {
  /** Last-Modified, or the ETag when the server sends no date. */
  version: string;
}

/**
 * A remote file read with Range requests. HEAD gives its size and version.
 * Every request carries the User-Agent and `signal`; a server that ignores
 * Range (answers 200) is an error rather than a full download.
 */
export async function openHttpZip(
  url: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<HttpZip> {
  const headers = { "User-Agent": userAgent() };
  const head = await fetchFn(url, {
    method: "HEAD",
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  await head.body?.cancel();
  if (!head.ok) throw new Error(`HEAD ${url}: HTTP ${head.status}`);
  const size = Number(head.headers.get("content-length"));
  const version = head.headers.get("last-modified") ?? head.headers.get("etag");
  if (!Number.isSafeInteger(size) || size <= 0 || !version) {
    throw new Error(`HEAD ${url}: no Content-Length or Last-Modified`);
  }

  async function range(start: number, end: number, timeout?: AbortSignal): Promise<Response> {
    const res = await fetchFn(url, {
      headers: { ...headers, Range: `bytes=${start}-${end - 1}` },
      signal: timeout ? AbortSignal.any([signal, timeout]) : signal,
    });
    if (res.status !== 206) {
      await res.body?.cancel();
      throw new Error(`GET ${url} bytes ${start}-${end - 1}: HTTP ${res.status}, expected 206`);
    }
    return res;
  }

  return {
    size,
    version,
    async bytes(start, end) {
      const res = await range(start, end, AbortSignal.timeout(60_000));
      return new Uint8Array(await res.arrayBuffer());
    },
    async stream(start, end) {
      // No overall timeout: the caller reads slowly, pausing while it pushes rows.
      const res = await range(start, end);
      if (!res.body) throw new Error(`GET ${url}: empty body`);
      return res.body;
    },
  };
}
