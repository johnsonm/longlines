import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ARCHIVE_S3_ENV,
  archiveS3Config,
  createArchiveObjectStore,
  createArchiveStore,
} from "../archive_store.ts";

const ENV: Record<string, string> = {
  [ARCHIVE_S3_ENV.endpoint]: "https://s3.us-west-004.backblazeb2.com",
  [ARCHIVE_S3_ENV.region]: "us-west-004",
  [ARCHIVE_S3_ENV.bucket]: "longlines-archive",
  [ARCHIVE_S3_ENV.accessKeyId]: "key-id",
  [ARCHIVE_S3_ENV.secretAccessKey]: " secret ",
};
function env(overrides: Record<string, string | undefined>) {
  return function (name: string) {
    if (name in overrides) {
      return overrides[name];
    }
    return ENV[name];
  };
}

Deno.test("archiveS3Config reads the five secrets, trimmed", function (): void {
  const config = archiveS3Config(env({}));
  assertEquals(config.endpoint.href, "https://s3.us-west-004.backblazeb2.com/");
  assertEquals(
    [config.region, config.bucket, config.accessKeyId, config.secretAccessKey],
    ["us-west-004", "longlines-archive", "key-id", "secret"],
  );
});

Deno.test("archiveS3Config names every missing secret", function (): void {
  assertThrows(
    () =>
      archiveS3Config(env({ [ARCHIVE_S3_ENV.bucket]: undefined, [ARCHIVE_S3_ENV.region]: " " })),
    Error,
    "archive store not configured: missing LONGLINES_ARCHIVE_S3_REGION, LONGLINES_ARCHIVE_S3_BUCKET",
  );
});

Deno.test("archiveS3Config wants an https URL except for the local stack", function (): void {
  assertThrows(
    () => archiveS3Config(env({ [ARCHIVE_S3_ENV.endpoint]: "s3 please" })),
    Error,
    "is not a URL",
  );
  assertThrows(
    () => archiveS3Config(env({ [ARCHIVE_S3_ENV.endpoint]: "http://s3.example.com" })),
    Error,
    "must be https",
  );
  for (const local of ["http://127.0.0.1:54321/storage/v1/s3", "http://kong:8000/storage/v1/s3"]) {
    assertEquals(archiveS3Config(env({ [ARCHIVE_S3_ENV.endpoint]: local })).endpoint.href, local);
  }
});

Deno.test(
  "createArchiveStore PUTs Parquet to the bucket and names the path on failure",
  async function (): Promise<void> {
    const seen: string[] = [];
    let status = 200;
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, function (req) {
      seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("content-type")}`);
      let body = "";
      if (status !== 200) {
        body = "<Error><Code>InternalError</Code></Error>";
      }
      return new Response(body, { status });
    });
    try {
      const store = createArchiveStore(
        archiveS3Config(env({ [ARCHIVE_S3_ENV.endpoint]: `http://127.0.0.1:${server.addr.port}` })),
      );
      await store.upload("rbn/year=2026/month=10/day=11/1410.parquet", new Uint8Array([1]));
      assertEquals(seen, [
        "PUT /longlines-archive/rbn/year%3D2026/month%3D10/day%3D11/1410.parquet " +
        "application/vnd.apache.parquet",
      ]);
      status = 500;
      await assertRejects(
        () => store.upload("p", new Uint8Array([1])),
        Error,
        "archive upload failed for p: HTTP 500 InternalError",
      );
    } finally {
      await server.shutdown();
    }
  },
);

Deno.test(
  "createArchiveObjectStore reads, sizes and deletes, naming the path on failure",
  async function (): Promise<void> {
    const seen: string[] = [];
    let status = 200;
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, function (req) {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      if (status !== 200) {
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status });
      }
      if (req.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response("abc", { status: 200 });
    });
    try {
      const store = createArchiveObjectStore(
        archiveS3Config(env({ [ARCHIVE_S3_ENV.endpoint]: `http://127.0.0.1:${server.addr.port}` })),
      );
      const path = "rbn/2026/10/11/1410.ndjson.gz";
      assertEquals(await store.read(path), new TextEncoder().encode("abc"));
      assertEquals(await store.size(path), 3);
      await store.remove(path);
      assertEquals(seen, [
        `GET /longlines-archive/${path}`,
        `HEAD /longlines-archive/${path}`,
        `DELETE /longlines-archive/${path}`,
      ]);
      status = 403;
      await assertRejects(
        () => store.read(path),
        Error,
        `archive read failed for ${path}: HTTP 403`,
      );
      await assertRejects(() => store.size(path), Error, `archive size check failed for ${path}`);
      await assertRejects(() => store.remove(path), Error, `archive delete failed for ${path}`);
    } finally {
      await server.shutdown();
    }
  },
);
