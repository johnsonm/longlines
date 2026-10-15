import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ARCHIVE_S3_ENV, archiveS3Config, createArchiveStore } from "../archive_store.ts";

const ENV: Record<string, string> = {
  [ARCHIVE_S3_ENV.endpoint]: "https://s3.us-west-004.backblazeb2.com",
  [ARCHIVE_S3_ENV.region]: "us-west-004",
  [ARCHIVE_S3_ENV.bucket]: "longlines-archive",
  [ARCHIVE_S3_ENV.accessKeyId]: "key-id",
  [ARCHIVE_S3_ENV.secretAccessKey]: " secret ",
};
const env = (overrides: Record<string, string | undefined> = {}) => (name: string) =>
  name in overrides ? overrides[name] : ENV[name];

Deno.test("archiveS3Config reads the five secrets, trimmed", () => {
  const config = archiveS3Config(env());
  assertEquals(config.endpoint.href, "https://s3.us-west-004.backblazeb2.com/");
  assertEquals(
    [config.region, config.bucket, config.accessKeyId, config.secretAccessKey],
    ["us-west-004", "longlines-archive", "key-id", "secret"],
  );
});

Deno.test("archiveS3Config names every missing secret", () => {
  assertThrows(
    () =>
      archiveS3Config(env({ [ARCHIVE_S3_ENV.bucket]: undefined, [ARCHIVE_S3_ENV.region]: " " })),
    Error,
    "archive store not configured: missing LONGLINES_ARCHIVE_S3_REGION, LONGLINES_ARCHIVE_S3_BUCKET",
  );
});

Deno.test("archiveS3Config wants an https URL except for the local stack", () => {
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

Deno.test("createArchiveStore PUTs Parquet to the bucket and names the path on failure", async () => {
  const seen: string[] = [];
  let status = 200;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("content-type")}`);
    return new Response(status === 200 ? "" : "<Error><Code>InternalError</Code></Error>", {
      status,
    });
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
});
