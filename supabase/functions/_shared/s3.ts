// Minimal S3 client: signed PutObject, plus GetObject, HeadObject and DeleteObject
// for the one-off NDJSON conversion (archive_convert.ts). The archive writes to Backblaze B2
// through its S3-compatible API (local Supabase Storage speaks the same API, so
// development needs no B2 account). Signature Version 4 over WebCrypto, no
// dependency; the tests pin AWS's published examples.
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html

import { userAgent } from "./http.ts";

export interface S3Config {
  /** Origin plus optional path prefix, e.g. https://s3.us-west-004.backblazeb2.com. */
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Request {
  method: string;
  /** The canonical (already percent-encoded) path, sent as is. */
  path: string;
  /** Lower-case header names to sign; must include `host` and `x-amz-date`. */
  headers: Readonly<Record<string, string>>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const REQUEST_TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/** `20130524T000000Z`: the x-amz-date form of an instant. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** One path segment, encoded as S3 canonicalizes it (RFC 3986 unreserved kept). */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The Authorization header for a request without a query string. */
export async function sigV4Authorization(req: SigV4Request): Promise<string> {
  const date = req.headers["x-amz-date"];
  if (date === undefined || req.headers["host"] === undefined) {
    throw new Error("sigV4Authorization needs host and x-amz-date headers");
  }
  const names = Object.keys(req.headers).sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    req.method,
    req.path,
    "",
    ...names.map((n) => `${n}:${req.headers[n]!.trim()}`),
    "",
    signedHeaders,
    req.payloadHash,
  ].join("\n");
  const scope = `${date.slice(0, 8)}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${req.secretAccessKey}`), date.slice(0, 8));
  for (const part of [req.region, req.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** The path-style URL of an object: `<endpoint>/<bucket>/<key>`. */
export function objectUrl(config: S3Config, key: string): URL {
  const prefix = config.endpoint.pathname.replace(/\/+$/, "");
  const path = [config.bucket, ...key.split("/")].map(encodeSegment).join("/");
  return new URL(`${config.endpoint.origin}${prefix}/${path}`);
}

/**
 * One signed request for an object. The payload hash is the body's real SHA-256
 * (the empty string's for GET, HEAD and DELETE).
 */
async function sendSigned(
  config: S3Config,
  method: "PUT" | "GET" | "HEAD" | "DELETE",
  key: string,
  now: Date,
  body?: { bytes: Uint8Array; contentType: string },
): Promise<Response> {
  const url = objectUrl(config, key);
  const signed: Record<string, string> = {
    ...(body ? { "content-type": body.contentType } : {}),
    host: url.host,
    "x-amz-content-sha256": await sha256Hex(body?.bytes ?? ""),
    "x-amz-date": amzDate(now),
  };
  const authorization = await sigV4Authorization({
    method,
    path: url.pathname,
    headers: signed,
    payloadHash: signed["x-amz-content-sha256"]!,
    region: config.region,
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  });
  // fetch sets Host from the URL; the other signed headers go as signed.
  const { host: _host, ...headers } = signed;
  return await fetch(url, {
    method,
    headers: { ...headers, Authorization: authorization, "User-Agent": userAgent() },
    ...(body ? { body: body.bytes as Uint8Array<ArrayBuffer> } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Throws for a non-2xx answer, naming S3's error code when the body has one. */
function httpError(response: Response, text: string): Error {
  // S3 errors are XML with a <Code>; it says more than the status alone.
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
  return new Error(`HTTP ${response.status}${code ? ` ${code}` : ""}`);
}

/** PUTs one object, replacing any at that key. Throws on non-2xx or timeout. */
export async function putObject(
  config: S3Config,
  key: string,
  body: Uint8Array,
  contentType: string,
  now: Date = new Date(),
): Promise<void> {
  const response = await sendSigned(config, "PUT", key, now, { bytes: body, contentType });
  const text = await response.text();
  if (!response.ok) throw httpError(response, text);
}

/**
 * GETs one object's bytes as stored, or null when there is none (404).
 * Throws on any other non-2xx or a timeout.
 */
export async function getObject(
  config: S3Config,
  key: string,
  now: Date = new Date(),
): Promise<Uint8Array | null> {
  const response = await sendSigned(config, "GET", key, now);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw httpError(response, await response.text());
  return new Uint8Array(await response.arrayBuffer());
}

/** An object's size from a HEAD, or null when there is none (404). Throws otherwise. */
export async function headObject(
  config: S3Config,
  key: string,
  now: Date = new Date(),
): Promise<number | null> {
  const response = await sendSigned(config, "HEAD", key, now);
  await response.body?.cancel();
  if (response.status === 404) return null;
  if (!response.ok) throw httpError(response, "");
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("HEAD answered without a Content-Length");
  }
  return length;
}

/** DELETEs one object; an object already gone is not an error. Throws on any other non-2xx. */
export async function deleteObject(
  config: S3Config,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  const response = await sendSigned(config, "DELETE", key, now);
  const text = await response.text();
  if (!response.ok && response.status !== 404) throw httpError(response, text);
}
