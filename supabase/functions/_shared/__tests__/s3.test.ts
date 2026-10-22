import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  amzDate,
  deleteObject,
  encodeSegment,
  getObject,
  headObject,
  objectUrl,
  putObject,
  type S3Config,
  sha256Hex,
  sigV4Authorization,
} from "../s3.ts";

// AWS's published examples. If one fails, fix the code, never the vector.
const AWS_KEY = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

Deno.test("sigV4Authorization matches AWS's S3 PUT Object example", async () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
  const payloadHash = await sha256Hex("Welcome to Amazon S3.");
  assertEquals(payloadHash, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
  const auth = await sigV4Authorization({
    method: "PUT",
    path: `/${encodeSegment("test$file.text")}`,
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      host: "examplebucket.s3.amazonaws.com",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": "20130524T000000Z",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    payloadHash,
    region: "us-east-1",
    service: "s3",
    ...AWS_KEY,
  });
  assertEquals(
    auth,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
});

Deno.test("sigV4Authorization matches AWS's S3 GET Object example", async () => {
  const payloadHash = await sha256Hex("");
  const auth = await sigV4Authorization({
    method: "GET",
    path: "/test.txt",
    headers: {
      host: "examplebucket.s3.amazonaws.com",
      range: "bytes=0-9",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash,
    region: "us-east-1",
    service: "s3",
    ...AWS_KEY,
  });
  assertEquals(
    auth.split("Signature=")[1],
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

Deno.test("sigV4Authorization refuses a request without host or x-amz-date", async () => {
  const base = {
    method: "PUT",
    path: "/",
    payloadHash: "x",
    region: "r",
    service: "s3",
    ...AWS_KEY,
  };
  await assertRejects(() => sigV4Authorization({ ...base, headers: { host: "h" } }));
  await assertRejects(() => sigV4Authorization({ ...base, headers: { "x-amz-date": "d" } }));
});

Deno.test("amzDate drops separators and milliseconds", () => {
  assertEquals(amzDate(new Date("2026-10-14T03:05:09.123Z")), "20261014T030509Z");
});

const config = (endpoint: string): S3Config => ({
  endpoint: new URL(endpoint),
  region: "us-west-004",
  bucket: "longlines-archive",
  ...AWS_KEY,
});

Deno.test("objectUrl is path-style, keeps an endpoint prefix and encodes Hive '='", () => {
  assertEquals(
    objectUrl(config("https://s3.us-west-004.backblazeb2.com"), "rbn/year=2026/1410.parquet").href,
    "https://s3.us-west-004.backblazeb2.com/longlines-archive/rbn/year%3D2026/1410.parquet",
  );
  assertEquals(
    objectUrl(config("http://127.0.0.1:54321/storage/v1/s3/"), "a b/c").pathname,
    "/storage/v1/s3/longlines-archive/a%20b/c",
  );
  assertThrows(() => objectUrl(config("not a url"), "k"));
});

Deno.test("putObject sends a signed PUT and surfaces the S3 error code", async () => {
  const seen: Array<{ method: string; path: string; headers: Headers; body: Uint8Array }> = [];
  let reply = new Response("", { status: 200 });
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    seen.push({
      method: req.method,
      path: new URL(req.url).pathname,
      headers: req.headers,
      body: new Uint8Array(await req.arrayBuffer()),
    });
    return reply;
  });
  try {
    const cfg = config(`http://127.0.0.1:${server.addr.port}/s3`);
    const bytes = new Uint8Array([1, 2, 3]);
    const now = new Date("2026-10-14T12:00:00Z");
    await putObject(
      cfg,
      "rbn/year=2026/1410.parquet",
      bytes,
      "application/vnd.apache.parquet",
      now,
    );
    const req = seen[0]!;
    assertEquals([req.method, req.path], [
      "PUT",
      "/s3/longlines-archive/rbn/year%3D2026/1410.parquet",
    ]);
    assertEquals(req.body, bytes);
    assertEquals(req.headers.get("x-amz-date"), "20261014T120000Z");
    assertEquals(req.headers.get("x-amz-content-sha256"), await sha256Hex(bytes));
    assertEquals(req.headers.get("content-type"), "application/vnd.apache.parquet");
    assertEquals(req.headers.get("user-agent")?.startsWith("LongLines/"), true);
    const auth = req.headers.get("authorization") ?? "";
    assertEquals(
      auth.startsWith(
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261014/us-west-004/s3/aws4_request, " +
          "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=",
      ),
      true,
    );

    reply = new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    await assertRejects(() => putObject(cfg, "k", bytes, "x"), Error, "HTTP 403 AccessDenied");
    reply = new Response("bad gateway", { status: 502 });
    await assertRejects(() => putObject(cfg, "k", bytes, "x"), Error, "HTTP 502");
  } finally {
    await server.shutdown();
  }
});

Deno.test("getObject, headObject and deleteObject send signed requests and read the answers", async () => {
  const seen: Array<{ method: string; path: string; auth: string; hash: string | null }> = [];
  let reply: () => Response = () => new Response("");
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    seen.push({
      method: req.method,
      path: new URL(req.url).pathname,
      auth: req.headers.get("authorization") ?? "",
      hash: req.headers.get("x-amz-content-sha256"),
    });
    return reply();
  });
  try {
    const cfg = config(`http://127.0.0.1:${server.addr.port}`);
    const key = "rbn/2026/10/11/1410.ndjson.gz";
    const now = new Date("2026-10-21T12:00:00Z");

    reply = () => new Response(new Uint8Array([0x1f, 0x8b, 1]));
    assertEquals(await getObject(cfg, key, now), new Uint8Array([0x1f, 0x8b, 1]));
    reply = () => new Response("12345", { headers: { "content-length": "5" } });
    assertEquals(await headObject(cfg, key, now), 5);
    reply = () => new Response(null, { status: 204 });
    await deleteObject(cfg, key, now);

    assertEquals(seen.map((s) => `${s.method} ${s.path}`), [
      `GET /longlines-archive/${key}`,
      `HEAD /longlines-archive/${key}`,
      `DELETE /longlines-archive/${key}`,
    ]);
    const emptyHash = await sha256Hex("");
    for (const s of seen) {
      assertEquals(s.hash, emptyHash);
      assertEquals(
        s.auth.startsWith(
          "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261021/us-west-004/s3/aws4_request, " +
            "SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=",
        ),
        true,
      );
    }

    reply = () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    assertEquals(await getObject(cfg, key), null);
    assertEquals(await headObject(cfg, key), null);
    await deleteObject(cfg, key);

    reply = () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    await assertRejects(() => getObject(cfg, key), Error, "HTTP 403 AccessDenied");
    await assertRejects(() => headObject(cfg, key), Error, "HTTP 403");
    await assertRejects(() => deleteObject(cfg, key), Error, "HTTP 403 AccessDenied");
  } finally {
    await server.shutdown();
  }
});
