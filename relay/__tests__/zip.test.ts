import { assertEquals, assertRejects } from "@std/assert";
import { crc32, openHttpZip, openZipEntry, readZipDirectory, type ZipEntry } from "../zip.ts";
import { buildZip, memorySource, readAll, serveZip } from "./zip_server.ts";

const big = Array.from({ length: 5000 }, (_, i) => `HD|${i}|||K${i}ABC|A|HA|||`).join("\r\n");
/** A copy of `entry`, built field by field, for a test to alter. */
function copyEntry(entry: ZipEntry): ZipEntry {
  return {
    name: entry.name,
    method: entry.method,
    compressedSize: entry.compressedSize,
    size: entry.size,
    headerOffset: entry.headerOffset,
    crc32: entry.crc32,
  };
}

const FILES = [
  { name: "counts", text: "HD 5000\n", stored: true },
  { name: "HD.dat", text: big },
  { name: "AM.dat", text: "AM|1|||K1ABC|E|\r\n" },
];

Deno.test(
  "readZipDirectory lists entries and openZipEntry inflates or copies them",
  async function (): Promise<void> {
    const src = memorySource(await buildZip(FILES));
    const entries = await readZipDirectory(src);
    assertEquals(entries.map((e) => [e.name, e.method]), [["counts", 0], ["HD.dat", 8], [
      "AM.dat",
      8,
    ]]);
    assertEquals(await readAll(await openZipEntry(src, entries[0]!)), "HD 5000\n");
    assertEquals(await readAll(await openZipEntry(src, entries[1]!)), big);
    assertEquals(await readAll(await openZipEntry(src, entries[2]!)), "AM|1|||K1ABC|E|\r\n");
  },
);

Deno.test(
  "readZipDirectory finds a directory that starts before the tail it reads",
  async function (): Promise<void> {
    const src = memorySource(await buildZip(FILES, "x".repeat(65_535)));
    assertEquals((await readZipDirectory(src)).map((e) => e.name), ["counts", "HD.dat", "AM.dat"]);
  },
);

Deno.test(
  "readZipDirectory rejects files that are not plain zips",
  async function (): Promise<void> {
    await assertRejects(
      () => readZipDirectory(memorySource(new TextEncoder().encode("<html>Not Found</html>"))),
      Error,
      "not a zip file",
    );
    const zip = await buildZip(FILES);
    const eocd = zip.length - 22;
    const zip64 = zip.slice();
    new DataView(zip64.buffer).setUint16(eocd + 10, 0xffff, true);
    await assertRejects(() => readZipDirectory(memorySource(zip64)), Error, "zip64");

    const encrypted = zip.slice();
    const dirOffset = new DataView(zip.buffer).getUint32(eocd + 16, true);
    new DataView(encrypted.buffer).setUint16(dirOffset + 8, 1, true);
    await assertRejects(() => readZipDirectory(memorySource(encrypted)), Error, "encrypted");

    const bigEntry = zip.slice();
    new DataView(bigEntry.buffer).setUint32(dirOffset + 24, 0xffffffff, true);
    await assertRejects(() => readZipDirectory(memorySource(bigEntry)), Error, "zip64");

    const corrupt = zip.slice();
    new DataView(corrupt.buffer).setUint32(dirOffset, 0, true);
    await assertRejects(() => readZipDirectory(memorySource(corrupt)), Error, "corrupt");
  },
);

Deno.test(
  "openZipEntry checks the method, the local header and the inflated size",
  async function (): Promise<void> {
    const src = memorySource(await buildZip(FILES));
    const entries = await readZipDirectory(src);
    const counts = entries[0]!;
    const hd = entries[1]!;
    const badMethod = copyEntry(counts);
    badMethod.method = 12;
    await assertRejects(
      () => openZipEntry(src, badMethod),
      Error,
      "compression method 12",
    );
    const badHeader = copyEntry(hd);
    badHeader.headerOffset = hd.headerOffset + 1;
    await assertRejects(
      () => openZipEntry(src, badHeader),
      Error,
      "corrupt local header",
    );
    const tooLong = copyEntry(hd);
    tooLong.size = hd.size + 1;
    await assertRejects(
      async () => await readAll(await openZipEntry(src, tooLong)),
      Error,
      `${hd.size} of ${hd.size + 1} bytes`,
    );
    const tooShort = copyEntry(counts);
    tooShort.size = 3;
    await assertRejects(
      async () => await readAll(await openZipEntry(src, tooShort)),
      Error,
      "more than 3 bytes",
    );
  },
);

Deno.test(
  "openHttpZip reads ranges with the User-Agent and reports Last-Modified",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const served = serveZip(zip);
    const url = served.url;
    const requests = served.requests;
    const server = served.server;
    try {
      const remote = await openHttpZip(url, new AbortController().signal);
      assertEquals([remote.size, remote.version], [zip.length, "Sun, 11 Oct 2026 13:18:48 GMT"]);
      const entries = await readZipDirectory(remote);
      assertEquals(await readAll(await openZipEntry(remote, entries[2]!)), "AM|1|||K1ABC|E|\r\n");
      assertEquals(requests[0]!.method, "HEAD");
      assertEquals(
        requests.slice(1).every((r) => r.range !== null && r.range.startsWith("bytes=")),
        true,
      );
      assertEquals(
        requests.every((r) => r.userAgent !== null && r.userAgent.startsWith("LongLines/")),
        true,
      );
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  "openHttpZip's stream gives up on a server that never sends headers, but not on a slow body",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const stalled = serveZip(zip, { stallHeaders: true });
    const slow = serveZip(zip);
    try {
      const remote = await openHttpZip(stalled.url, new AbortController().signal, fetch, 100);
      const entries = await readZipDirectory(remote);
      await assertRejects(
        () => openZipEntry(remote, entries[1]!),
        Error,
        "no response within 100 ms",
      );
      // Once headers arrive the timer is gone: reading after it would have fired still works.
      const ok = await openHttpZip(slow.url, new AbortController().signal, fetch, 100);
      const stream = await openZipEntry(ok, (await readZipDirectory(ok))[2]!);
      await new Promise((r) => setTimeout(r, 200));
      assertEquals(await readAll(stream), "AM|1|||K1ABC|E|\r\n");
    } finally {
      stalled.release();
      await stalled.server.shutdown();
      await slow.server.shutdown();
    }
  },
);

Deno.test(
  "openHttpZip refuses plain http except from a local server",
  async function (): Promise<void> {
    let fetched = 0;
    function countingFetch(): Promise<Response> {
      fetched++;
      return Promise.resolve(new Response(null));
    }
    await assertRejects(
      () => openHttpZip("http://data.fcc.gov/l_amat", new AbortController().signal, countingFetch),
      Error,
      "https is required",
    );
    assertEquals(fetched, 0);
  },
);

Deno.test(
  "openHttpZip refuses ranges once the file has changed since HEAD",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const served = serveZip(zip);
    const url = served.url;
    const requests = served.requests;
    const server = served.server;
    try {
      const remote = await openHttpZip(url, new AbortController().signal);
      const entries = await readZipDirectory(remote);
      served.republish("Sun, 18 Oct 2026 13:18:48 GMT");
      await assertRejects(() => openZipEntry(remote, entries[1]!), Error, "expected 206");
      assertEquals(requests.at(-1)!.ifRange, "Sun, 11 Oct 2026 13:18:48 GMT");
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  "openHttpZip refuses a server without Range support or a version",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const noRange = serveZip(zip, { ignoreRange: true });
    const noDate = serveZip(zip, { lastModified: null });
    try {
      const remote = await openHttpZip(noRange.url, new AbortController().signal);
      await assertRejects(() => readZipDirectory(remote), Error, "expected 206");
      const hd = {
        name: "HD.dat",
        method: 8,
        compressedSize: 10,
        size: 10,
        headerOffset: 0,
        crc32: 0,
      };
      await assertRejects(() => remote.stream(0, 10), Error, "expected 206");
      await assertRejects(() => openZipEntry(remote, hd), Error, "expected 206");
      await assertRejects(
        () => openHttpZip(noDate.url, new AbortController().signal),
        Error,
        "no Last-Modified or ETag",
      );
      await assertRejects(
        () =>
          openHttpZip(
            noDate.url.replace("l_amat", "missing"),
            new AbortController().signal,
            () => Promise.resolve(new Response(null, { status: 404 })),
          ),
        Error,
        "HTTP 404",
      );
    } finally {
      await noRange.server.shutdown();
      await noDate.server.shutdown();
    }
  },
);

Deno.test(
  "crc32 matches the standard check value, in one call or folded over pieces",
  function (): void {
    const bytes = new TextEncoder().encode("123456789");
    assertEquals(crc32(bytes), 0xcbf43926);
    assertEquals(crc32(bytes.subarray(4), crc32(bytes.subarray(0, 4))), 0xcbf43926);
    assertEquals(crc32(new Uint8Array()), 0);
  },
);

Deno.test(
  "openZipEntry refuses an entry whose CRC-32 does not match",
  async function (): Promise<void> {
    const src = memorySource(
      await buildZip([
        { name: "AM.dat", text: "AM|1|||K1ABC|E|\r\n", crc: 1 },
        { name: "counts", text: "x", stored: true, crc: 2 },
      ]),
    );
    const entries = await readZipDirectory(src);
    const am = entries[0]!;
    const counts = entries[1]!;
    await assertRejects(async () => await readAll(await openZipEntry(src, am)), Error, "CRC-32");
    await assertRejects(
      async () => await readAll(await openZipEntry(src, counts)),
      Error,
      "CRC-32",
    );
  },
);

Deno.test(
  "readZipDirectory needs the end record's comment to reach the end of the file",
  async function (): Promise<void> {
    const zip = await buildZip(FILES, "note");
    // A comment length that runs past the end (or stops short) is no end record.
    const wrong = zip.slice();
    new DataView(wrong.buffer).setUint16(zip.length - 4 - 2, 5, true);
    await assertRejects(() => readZipDirectory(memorySource(wrong)), Error, "not a zip file");
    // Trailing bytes after the comment are refused too.
    const trailing = new Uint8Array(zip.length + 3);
    trailing.set(zip);
    await assertRejects(() => readZipDirectory(memorySource(trailing)), Error, "not a zip file");
    // The signature inside a comment is skipped in favour of the real record.
    const sig = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
    const tricky = await buildZip(FILES, new TextDecoder("latin1").decode(sig) + "y".repeat(30));
    assertEquals((await readZipDirectory(memorySource(tricky))).length, 3);
  },
);

Deno.test(
  "openHttpZip refuses a short body or a shifted Content-Range",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const short = serveZip(zip, { shortBody: true });
    const shifted = serveZip(zip, { shiftRange: true });
    try {
      const a = await openHttpZip(short.url, new AbortController().signal);
      await assertRejects(() => a.bytes(0, 100), Error, "does not match");
      const b = await openHttpZip(shifted.url, new AbortController().signal);
      await assertRejects(() => readZipDirectory(b), Error, "does not match");
      await assertRejects(() => b.stream(10, 20), Error, "does not match");
    } finally {
      await short.server.shutdown();
      await shifted.server.shutdown();
    }
  },
);

Deno.test(
  "openHttpZip bytes() refuses a body shorter than its Content-Range",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    function fake(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (init !== undefined && init.method === "HEAD") {
        return Promise.resolve(
          new Response(null, {
            headers: { "content-length": String(zip.length), "last-modified": "Sun" },
          }),
        );
      }
      return Promise.resolve(
        new Response(zip.slice(0, 5), {
          status: 206,
          headers: { "content-range": `bytes 0-9/${zip.length}` },
        }),
      );
    }
    const remote = await openHttpZip(
      "https://example.test/l_amat",
      new AbortController().signal,
      fake,
    );
    await assertRejects(() => remote.bytes(0, 10), Error, "5 of 10 bytes");
  },
);

Deno.test(
  "openHttpZip sends a strong ETag in If-Range but keeps Last-Modified as the version",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const served = serveZip(zip, { etag: '"abc123"' });
    const url = served.url;
    const requests = served.requests;
    const server = served.server;
    try {
      const remote = await openHttpZip(url, new AbortController().signal);
      assertEquals(remote.version, "Sun, 11 Oct 2026 13:18:48 GMT");
      const entries = await readZipDirectory(remote);
      assertEquals(await readAll(await openZipEntry(remote, entries[2]!)), "AM|1|||K1ABC|E|\r\n");
      assertEquals(requests.slice(1).every((r) => r.ifRange === '"abc123"'), true);
      served.republish("Sun, 18 Oct 2026 13:18:48 GMT", '"def456"');
      await assertRejects(() => openZipEntry(remote, entries[1]!), Error, "expected 206");
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  "openHttpZip uses a strong ETag as the version when there is no date",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const served = serveZip(zip, { etag: '"abc123"', lastModified: null });
    const url = served.url;
    const requests = served.requests;
    const server = served.server;
    try {
      const remote = await openHttpZip(url, new AbortController().signal);
      assertEquals(remote.version, '"abc123"');
      assertEquals((await readZipDirectory(remote)).length, 3);
      assertEquals(requests.at(-1)!.ifRange, '"abc123"');
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  "openHttpZip falls back to Last-Modified beside a weak ETag and refuses a weak ETag alone",
  async function (): Promise<void> {
    const zip = await buildZip(FILES);
    const weak = serveZip(zip, { etag: 'W/"abc123"' });
    const weakOnly = serveZip(zip, { etag: 'W/"abc123"', lastModified: null });
    try {
      const remote = await openHttpZip(weak.url, new AbortController().signal);
      assertEquals((await readZipDirectory(remote)).length, 3);
      assertEquals(weak.requests.at(-1)!.ifRange, "Sun, 11 Oct 2026 13:18:48 GMT");
      await assertRejects(
        () => openHttpZip(weakOnly.url, new AbortController().signal),
        Error,
        "only a weak ETag",
      );
    } finally {
      await weak.server.shutdown();
      await weakOnly.server.shutdown();
    }
  },
);
