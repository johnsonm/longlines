import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { FunctionCallError, ValidationError } from "../errors.ts";
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

Deno.test(
  "sigV4Authorization matches AWS's S3 PUT Object example",
  async function (): Promise<void> {
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
      accessKeyId: AWS_KEY.accessKeyId,
      secretAccessKey: AWS_KEY.secretAccessKey,
    });
    assertEquals(
      auth,
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  },
);

Deno.test(
  "sigV4Authorization matches AWS's S3 GET Object example",
  async function (): Promise<void> {
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
      accessKeyId: AWS_KEY.accessKeyId,
      secretAccessKey: AWS_KEY.secretAccessKey,
    });
    assertEquals(
      auth.split("Signature=")[1],
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  },
);

Deno.test(
  "sigV4Authorization refuses a request without host or x-amz-date",
  async function (): Promise<void> {
    const base = {
      method: "PUT",
      path: "/",
      payloadHash: "x",
      region: "r",
      service: "s3",
      accessKeyId: AWS_KEY.accessKeyId,
      secretAccessKey: AWS_KEY.secretAccessKey,
    };
    await assertRejects(
      () => sigV4Authorization(Object.assign({}, base, { headers: { host: "h" } })),
      ValidationError,
      "needs host and x-amz-date",
    );
    await assertRejects(
      () => sigV4Authorization(Object.assign({}, base, { headers: { "x-amz-date": "d" } })),
      ValidationError,
      "needs host and x-amz-date",
    );
  },
);

Deno.test("amzDate drops separators and milliseconds", function (): void {
  assertEquals(amzDate(new Date("2026-10-14T03:05:09.123Z")), "20261014T030509Z");
});

function config(endpoint: string): S3Config {
  return {
    endpoint: new URL(endpoint),
    region: "us-west-004",
    bucket: "longlines-archive",
    accessKeyId: AWS_KEY.accessKeyId,
    secretAccessKey: AWS_KEY.secretAccessKey,
  };
}

Deno.test(
  "objectUrl is path-style, keeps an endpoint prefix and encodes Hive '='",
  function (): void {
    assertEquals(
      objectUrl(config("https://s3.us-west-004.backblazeb2.com"), "rbn/year=2026/1410.parquet")
        .href,
      "https://s3.us-west-004.backblazeb2.com/longlines-archive/rbn/year%3D2026/1410.parquet",
    );
    assertEquals(
      objectUrl(config("http://127.0.0.1:54321/storage/v1/s3/"), "a b/c").pathname,
      "/storage/v1/s3/longlines-archive/a%20b/c",
    );
    assertThrows(() => objectUrl(config("not a url"), "k"));
  },
);

Deno.test(
  "putObject sends a signed PUT and surfaces the S3 error code",
  async function (): Promise<void> {
    const seen: Array<{ method: string; path: string; headers: Headers; body: Uint8Array }> = [];
    let reply = new Response("", { status: 200 });
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async function (req) {
        seen.push({
          method: req.method,
          path: new URL(req.url).pathname,
          headers: req.headers,
          body: new Uint8Array(await req.arrayBuffer()),
        });
        return reply;
      },
    );
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
      const agent = req.headers.get("user-agent");
      assertExists(agent);
      assertEquals(agent.startsWith("LongLines/"), true);
      const auth = req.headers.get("authorization");
      assertExists(auth);
      assertEquals(
        auth.startsWith(
          "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261014/us-west-004/s3/aws4_request, " +
            "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=",
        ),
        true,
      );

      reply = new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      const denied = await assertRejects(
        () => putObject(cfg, "k", bytes, "x", new Date()),
        FunctionCallError,
        "S3 PUT k: HTTP 403 AccessDenied",
      );
      assertEquals(denied.status, 403);
      reply = new Response("bad gateway", { status: 502 });
      await assertRejects(
        () => putObject(cfg, "k", bytes, "x", new Date()),
        FunctionCallError,
        "S3 PUT k: HTTP 502",
      );
    } finally {
      await server.shutdown();
    }
  },
);

function emptyReply(): Response {
  return new Response("");
}

Deno.test(
  "getObject, headObject and deleteObject send signed requests and read the answers",
  async function (): Promise<void> {
    const seen: Array<{ method: string; path: string; auth: string; hash: string | null }> = [];
    let reply: () => Response = emptyReply;
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, function (req) {
      let auth = req.headers.get("authorization");
      if (auth === null) {
        auth = "";
      }
      seen.push({
        method: req.method,
        path: new URL(req.url).pathname,
        auth,
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
      assertEquals(await getObject(cfg, key, new Date()), null);
      assertEquals(await headObject(cfg, key, new Date()), null);
      await deleteObject(cfg, key, new Date());

      reply = () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      await assertRejects(
        () => getObject(cfg, key, new Date()),
        FunctionCallError,
        `S3 GET ${key}: HTTP 403 AccessDenied`,
      );
      await assertRejects(
        () => headObject(cfg, key, new Date()),
        FunctionCallError,
        `S3 HEAD ${key}: HTTP 403`,
      );
      await assertRejects(
        () => deleteObject(cfg, key, new Date()),
        FunctionCallError,
        `S3 DELETE ${key}: HTTP 403 AccessDenied`,
      );

      // A streamed body goes chunked, so the HEAD answer has no Content-Length; that is
      // no size at all, not 0.
      reply = () => new Response(ReadableStream.from([new Uint8Array([1])]));
      await assertRejects(
        () => headObject(cfg, key, new Date()),
        ValidationError,
        `S3 HEAD ${key} answered without a Content-Length`,
      );
    } finally {
      await server.shutdown();
    }
  },
);
