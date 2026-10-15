// Where the archive's Parquet files go: an S3-compatible bucket named by the
// LONGLINES_ARCHIVE_S3_* function secrets. Hosted, that is Backblaze B2 with an
// application key restricted to the archive bucket and `writeFiles`; locally,
// the stack's own Storage S3 endpoint and its `archive` bucket.

import { putObject, type S3Config } from "./s3.ts";
import type { ArchiveStore } from "./types.ts";

export const ARCHIVE_S3_ENV = {
  endpoint: "LONGLINES_ARCHIVE_S3_ENDPOINT",
  region: "LONGLINES_ARCHIVE_S3_REGION",
  bucket: "LONGLINES_ARCHIVE_S3_BUCKET",
  accessKeyId: "LONGLINES_ARCHIVE_S3_ACCESS_KEY_ID",
  secretAccessKey: "LONGLINES_ARCHIVE_S3_SECRET_ACCESS_KEY",
} as const;

/** Hosts allowed over plain http: the local stack, seen from the host or from the functions container. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "kong", "host.docker.internal"]);

/** The store's settings from the environment. Throws naming every missing or bad variable. */
export function archiveS3Config(get: (name: string) => string | undefined): S3Config {
  const values: Partial<Record<keyof typeof ARCHIVE_S3_ENV, string>> = {};
  const missing: string[] = [];
  for (const [field, name] of Object.entries(ARCHIVE_S3_ENV)) {
    const value = get(name)?.trim();
    if (value) values[field as keyof typeof ARCHIVE_S3_ENV] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`archive store not configured: missing ${missing.join(", ")}`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(values.endpoint!);
  } catch {
    throw new Error(`${ARCHIVE_S3_ENV.endpoint} is not a URL`);
  }
  if (endpoint.protocol !== "https:" && !LOCAL_HOSTS.has(endpoint.hostname)) {
    throw new Error(`${ARCHIVE_S3_ENV.endpoint} must be https`);
  }
  return {
    endpoint,
    region: values.region!,
    bucket: values.bucket!,
    accessKeyId: values.accessKeyId!,
    secretAccessKey: values.secretAccessKey!,
  };
}

export function createArchiveStore(config: S3Config): ArchiveStore {
  return {
    async upload(path: string, bytes: Uint8Array): Promise<void> {
      try {
        await putObject(config, path, bytes, "application/vnd.apache.parquet");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`archive upload failed for ${path}: ${message}`);
      }
    },
  };
}
