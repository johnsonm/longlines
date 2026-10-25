// Where the archive's Parquet files go: an S3-compatible bucket named by the
// LONGLINES_ARCHIVE_S3_* function secrets. Hosted, that is Backblaze B2 with an
// application key restricted to the archive bucket and `writeFiles`; locally,
// the stack's own Storage S3 endpoint and its `archive` bucket.

import { deleteObject, getObject, headObject, putObject, type S3Config } from "./s3.ts";
import type { ArchiveObjectStore, ArchiveStore } from "./types.ts";

export const ARCHIVE_S3_ENV = {
  endpoint: "LONGLINES_ARCHIVE_S3_ENDPOINT",
  region: "LONGLINES_ARCHIVE_S3_REGION",
  bucket: "LONGLINES_ARCHIVE_S3_BUCKET",
  accessKeyId: "LONGLINES_ARCHIVE_S3_ACCESS_KEY_ID",
  secretAccessKey: "LONGLINES_ARCHIVE_S3_SECRET_ACCESS_KEY",
} as const;

/** Hosts allowed over plain http: the local stack, seen from the host or from the functions container. */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "kong", "host.docker.internal"]);

type ArchiveS3Field = keyof typeof ARCHIVE_S3_ENV;

/** A setting archiveS3Config stored; a missing one has already thrown. */
function required(values: Partial<Record<ArchiveS3Field, string>>, field: ArchiveS3Field): string {
  const value = values[field];
  if (value === undefined) {
    throw new Error(`archiveS3Config: no value for ${field}`);
  }
  return value;
}

/** The store's settings from the environment. Throws naming every missing or bad variable. */
export function archiveS3Config(get: (name: string) => string | undefined): S3Config {
  const values: Partial<Record<keyof typeof ARCHIVE_S3_ENV, string>> = {};
  const missing: string[] = [];
  for (const entry of Object.entries(ARCHIVE_S3_ENV)) {
    const field = entry[0];
    const name = entry[1];
    const raw = get(name);
    let value = "";
    if (raw !== undefined) {
      value = raw.trim();
    }
    if (value !== "") {
      values[field as keyof typeof ARCHIVE_S3_ENV] = value;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`archive store not configured: missing ${missing.join(", ")}`);
  }
  const endpointText = required(values, "endpoint");
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new Error(`${ARCHIVE_S3_ENV.endpoint} is not a URL`);
  }
  if (endpoint.protocol !== "https:" && !LOCAL_HOSTS.has(endpoint.hostname)) {
    throw new Error(`${ARCHIVE_S3_ENV.endpoint} must be https`);
  }
  return {
    endpoint,
    region: required(values, "region"),
    bucket: required(values, "bucket"),
    accessKeyId: required(values, "accessKeyId"),
    secretAccessKey: required(values, "secretAccessKey"),
  };
}

export function createArchiveStore(config: S3Config): ArchiveStore {
  return createArchiveObjectStore(config);
}

/** Prefixes a store failure with what it was doing and to which path. */
async function naming<T>(what: string, path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    let message: string;
    if (error instanceof Error) {
      message = error.message;
    } else {
      message = String(error);
    }
    throw new Error(`archive ${what} failed for ${path}: ${message}`);
  }
}

/**
 * The bucket with read, size and delete as well as upload, for the one-off
 * NDJSON conversion (archive_convert.ts). Its key needs readFiles and
 * deleteFiles on top of writeFiles (docs/OPERATIONS.md).
 */
export function createArchiveObjectStore(config: S3Config): ArchiveObjectStore {
  return {
    read: (path) => naming("read", path, () => getObject(config, path, new Date())),
    size: (path) => naming("size check", path, () => headObject(config, path, new Date())),
    remove: (path) => naming("delete", path, () => deleteObject(config, path, new Date())),
    upload: (path, bytes) =>
      naming(
        "upload",
        path,
        () => putObject(config, path, bytes, "application/vnd.apache.parquet", new Date()),
      ),
  };
}
