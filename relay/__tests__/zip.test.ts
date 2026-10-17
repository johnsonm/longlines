import { assertEquals, assertRejects } from "@std/assert";
import { openHttpZip, openZipEntry, readZipDirectory } from "../zip.ts";
import { buildZip, memorySource, readAll, serveZip } from "./zip_server.ts";

const big = Array.from({ length: 5000 }, (_, i) => `HD|${i}|||K${i}ABC|A|HA|||`).join("\r\n");
const FILES = [
  { name: "counts", text: "HD 5000\n", stored: true },
  { name: "HD.dat", text: big },
  { name: "AM.dat", text: "AM|1|||K1ABC|E|\r\n" },
];

Deno.test("readZipDirectory lists entries and openZipEntry inflates or copies them", async () => {
  const src = memorySource(await buildZip(FILES));
  const entries = await readZipDirectory(src);
  assertEquals(entries.map((e) => [e.name, e.method]), [["counts", 0], ["HD.dat", 8], [
    "AM.dat",
    8,
  ]]);
  assertEquals(await readAll(await openZipEntry(src, entries[0]!)), "HD 5000\n");
  assertEquals(await readAll(await openZipEntry(src, entries[1]!)), big);
  assertEquals(await readAll(await openZipEntry(src, entries[2]!)), "AM|1|||K1ABC|E|\r\n");
});

Deno.test("readZipDirectory finds a directory that starts before the tail it reads", async () => {
  const src = memorySource(await buildZip(FILES, "x".repeat(65_535)));
  assertEquals((await readZipDirectory(src)).map((e) => e.name), ["counts", "HD.dat", "AM.dat"]);
});

Deno.test("readZipDirectory rejects files that are not plain zips", async () => {
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
});

Deno.test("openZipEntry checks the method, the local header and the inflated size", async () => {
  const src = memorySource(await buildZip(FILES));
  const [counts, hd] = await readZipDirectory(src);
  await assertRejects(
    () => openZipEntry(src, { ...counts!, method: 12 }),
    Error,
    "compression method 12",
  );
  await assertRejects(
    () => openZipEntry(src, { ...hd!, headerOffset: hd!.headerOffset + 1 }),
    Error,
    "corrupt local header",
  );
  await assertRejects(
    async () => await readAll(await openZipEntry(src, { ...hd!, size: hd!.size + 1 })),
    Error,
    `${hd!.size} of ${hd!.size + 1} bytes`,
  );
  await assertRejects(
    async () => await readAll(await openZipEntry(src, { ...counts!, size: 3 })),
    Error,
    "more than 3 bytes",
  );
});

Deno.test("openHttpZip reads ranges with the User-Agent and reports Last-Modified", async () => {
  const zip = await buildZip(FILES);
  const { url, requests, server } = serveZip(zip);
  try {
    const remote = await openHttpZip(url, new AbortController().signal);
    assertEquals([remote.size, remote.version], [zip.length, "Sun, 11 Oct 2026 13:18:48 GMT"]);
    const entries = await readZipDirectory(remote);
    assertEquals(await readAll(await openZipEntry(remote, entries[2]!)), "AM|1|||K1ABC|E|\r\n");
    assertEquals(requests[0]?.method, "HEAD");
    assertEquals(requests.slice(1).every((r) => r.range?.startsWith("bytes=")), true);
    assertEquals(requests.every((r) => r.userAgent?.startsWith("LongLines/")), true);
  } finally {
    await server.shutdown();
  }
});

Deno.test("openHttpZip's stream gives up on a server that never sends headers, but not on a slow body", async () => {
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
});

Deno.test("openHttpZip refuses plain http except from a local server", async () => {
  let fetched = 0;
  await assertRejects(
    () =>
      openHttpZip("http://data.fcc.gov/l_amat", new AbortController().signal, () => {
        fetched++;
        return Promise.resolve(new Response(null));
      }),
    Error,
    "https is required",
  );
  assertEquals(fetched, 0);
});

Deno.test("openHttpZip refuses ranges once the file has changed since HEAD", async () => {
  const zip = await buildZip(FILES);
  const { url, requests, server, republish } = serveZip(zip);
  try {
    const remote = await openHttpZip(url, new AbortController().signal);
    const entries = await readZipDirectory(remote);
    republish("Sun, 18 Oct 2026 13:18:48 GMT");
    await assertRejects(() => openZipEntry(remote, entries[1]!), Error, "expected 206");
    assertEquals(requests.at(-1)?.ifRange, "Sun, 11 Oct 2026 13:18:48 GMT");
  } finally {
    await server.shutdown();
  }
});

Deno.test("openHttpZip refuses a server without Range support or a version", async () => {
  const zip = await buildZip(FILES);
  const noRange = serveZip(zip, { ignoreRange: true });
  const noDate = serveZip(zip, { lastModified: null });
  try {
    const remote = await openHttpZip(noRange.url, new AbortController().signal);
    await assertRejects(() => readZipDirectory(remote), Error, "expected 206");
    const [hd] = [{ name: "HD.dat", method: 8, compressedSize: 10, size: 10, headerOffset: 0 }];
    await assertRejects(() => remote.stream(0, 10), Error, "expected 206");
    await assertRejects(() => openZipEntry(remote, hd), Error, "expected 206");
    await assertRejects(
      () => openHttpZip(noDate.url, new AbortController().signal),
      Error,
      "no Content-Length or Last-Modified",
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
});
