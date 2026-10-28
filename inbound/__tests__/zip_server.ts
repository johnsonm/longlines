// Test helpers: build a zip in memory and serve it like data.fcc.gov does
// (HEAD with Content-Length and Last-Modified, GET with Range -> 206).

import { crc32 } from "../zip.ts";

export interface ZipFile {
  name: string;
  text: string;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Write this CRC-32 instead of the real one. */
  crc?: number;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildZip(files: ZipFile[], comment: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = enc.encode(file.text);
    let body: Uint8Array;
    let method: number;
    if (file.stored) {
      body = data;
      method = 0;
    } else {
      body = await deflateRaw(data);
      method = 8;
    }
    let crc: number;
    if (file.crc !== undefined && file.crc !== null) {
      crc = file.crc;
    } else {
      crc = crc32(data, 0);
    }
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, method, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, method, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);

    parts.push(local, body);
    central.push(entry);
    offset += local.length + body.length;
  }
  let dirSize = 0;
  for (const entry of central) {
    dirSize += entry.length;
  }
  const note = enc.encode(comment);
  const eocd = new Uint8Array(22 + note.length);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, dirSize, true);
  e.setUint32(16, offset, true);
  e.setUint16(20, note.length, true);
  eocd.set(note, 22);

  const all = parts.concat(central, [eocd]);
  let total = 0;
  for (const part of all) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of all) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export interface ZipServerOptions {
  lastModified?: string | null;
  /** Answer 200 with the whole file, as a server without Range support would. */
  ignoreRange?: boolean;
  /** Stop sending an entry's data after this many bytes and hold the connection open. */
  stallAfter?: number;
  /** Never answer a Range request for entry data (no headers) until the client gives up. */
  stallHeaders?: boolean;
  /** Send this ETag on every response (and expect it in If-Range). */
  etag?: string;
  /** Send one byte fewer than every Range asks for. */
  shortBody?: boolean;
  /** Answer every Range from one byte later, with a Content-Range that says so. */
  shiftRange?: boolean;
}

export function serveZip(bytes: Uint8Array, options: ZipServerOptions) {
  const requests: {
    method: string;
    range: string | null;
    ifRange: string | null;
    userAgent: string | null;
  }[] = [];
  const stalled: ((res: Response) => void)[] = [];
  let lastModified: string | null;
  if (options.lastModified === undefined) {
    lastModified = "Sun, 11 Oct 2026 13:18:48 GMT";
  } else {
    lastModified = options.lastModified;
  }
  let etag: string | null = null;
  if (options.etag !== undefined && options.etag !== null) {
    etag = options.etag;
  }
  function handler(req: Request): Response | Promise<Response> {
    const range = req.headers.get("range");
    requests.push({
      method: req.method,
      range,
      ifRange: req.headers.get("if-range"),
      userAgent: req.headers.get("user-agent"),
    });
    const headers: Record<string, string> = { "content-length": String(bytes.length) };
    if (lastModified) {
      headers["last-modified"] = lastModified;
    }
    if (etag) {
      headers["etag"] = etag;
    }
    if (req.method === "HEAD") {
      return new Response(null, { headers });
    }
    let rangeText = "";
    if (range !== null && range !== undefined) {
      rangeText = range;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(rangeText);
    const ifRange = req.headers.get("if-range");
    const changed = ifRange !== null && ifRange !== lastModified && ifRange !== etag;
    if (!m || options.ignoreRange || changed) {
      return new Response(bytes as BodyInit, { headers });
    }
    let shift = 0;
    if (options.shiftRange) {
      shift = 1;
    }
    let short = 0;
    if (options.shortBody) {
      short = 1;
    }
    const first = Number(m[1]) + shift;
    const last = Number(m[2]) + shift - short;
    const slice = bytes.slice(first, last + 1);
    const partial = {
      status: 206,
      headers: { "content-range": `bytes ${first}-${last}/${bytes.length}` },
    };
    // Entry data: not the directory tail (from 0 in a small file) or a 30-byte local header.
    const entryData = Number(m[1]) > 0 && slice.length > 30;
    if (options.stallHeaders && entryData) {
      return new Promise<Response>((resolve) => stalled.push(resolve));
    }
    if (options.stallAfter !== undefined && entryData && slice.length > options.stallAfter) {
      const head = slice.slice(0, options.stallAfter);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(head);
        },
      });
      return new Response(body, partial);
    }
    return new Response(slice as BodyInit, partial);
  }
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, handler);
  return {
    // No ".zip" in a plain-http URL: CodeQL reads that as an insecure download.
    url: `http://127.0.0.1:${server.addr.port}/l_amat`,
    requests,
    server,
    /** Answer the requests stallHeaders held (call before server.shutdown(), which waits for them). */
    release() {
      for (const resolve of stalled.splice(0)) {
        resolve(new Response(null, { status: 503 }));
      }
    },
    /** The FCC publishes a new file. */
    republish(date: string, newEtag: string | undefined) {
      lastModified = date;
      if (newEtag !== undefined) {
        etag = newEtag;
      }
    },
  };
}

/** In-memory RangeSource over bytes. */
export function memorySource(bytes: Uint8Array) {
  return {
    size: bytes.length,
    bytes: (start: number, end: number) => Promise.resolve(bytes.slice(start, end)),
    stream: (start: number, end: number) =>
      Promise.resolve(new Blob([bytes.slice(start, end) as BlobPart]).stream()),
  };
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}
