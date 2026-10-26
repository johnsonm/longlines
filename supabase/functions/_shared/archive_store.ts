// Where the archive's Parquet files go: an S3-compatible bucket named by the
// LONGLINES_ARCHIVE_S3_* function secrets. Hosted, that is Backblaze B2 with an
// application key restricted to the archive bucket and `writeFiles`; locally,
// the stack's own Storage S3 endpoint and its `archive` bucket.

import { ConfigError } from "./errors.ts";
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

/** ARCHIVE_S3_ENV's fields in its key order, which the "missing" message follows. */
const ARCHIVE_S3_FIELDS: readonly ArchiveS3Field[] = [
  "endpoint",
  "region",
  "bucket",
  "accessKeyId",
  "secretAccessKey",
];

/** A setting archiveS3Config stored; a missing one has already thrown. */
function required(values: Partial<Record<ArchiveS3Field, string>>, field: ArchiveS3Field): string {
  const value = values[field];
  if (value === undefined) {
    throw new ConfigError(`archiveS3Config: no value for ${field}`, { cause: undefined });
  }
  return value;
}

/** The store's settings from the environment. Throws naming every missing or bad variable. */
export function archiveS3Config(get: (name: string) => string | undefined): S3Config {
  const values: Partial<Record<ArchiveS3Field, string>> = {};
  const missing: string[] = [];
  for (const field of ARCHIVE_S3_FIELDS) {
    const name = ARCHIVE_S3_ENV[field];
    const raw = get(name);
    let value = "";
    if (raw !== undefined) {
      value = raw.trim();
    }
    if (value !== "") {
      values[field] = value;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new ConfigError(`archive store not configured: missing ${missing.join(", ")}`, {
      cause: undefined,
    });
  }
  const endpointText = required(values, "endpoint");
  if (!URL.canParse(endpointText)) {
    throw new ConfigError(`${ARCHIVE_S3_ENV.endpoint} is not a URL`, { cause: undefined });
  }
  const endpoint = new URL(endpointText);
  if (endpoint.protocol !== "https:" && !LOCAL_HOSTS.has(endpoint.hostname)) {
    throw new ConfigError(`${ARCHIVE_S3_ENV.endpoint} must be https`, { cause: undefined });
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

/**
 * The bucket with read, size and delete as well as upload, for the one-off
 * NDJSON conversion (archive_convert.ts). Its key needs readFiles and
 * deleteFiles on top of writeFiles (docs/OPERATIONS.md). A failed answer is s3.ts's
 * FunctionCallError, whose message names the method and the path.
 */
export function createArchiveObjectStore(config: S3Config): ArchiveObjectStore {
  return {
    read: (path) => getObject(config, path, new Date()),
    size: (path) => headObject(config, path, new Date()),
    remove: (path) => deleteObject(config, path, new Date()),
    upload: (path, bytes) =>
      putObject(config, path, bytes, "application/vnd.apache.parquet", new Date()),
  };
}
