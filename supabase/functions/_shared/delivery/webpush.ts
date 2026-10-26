// Web Push on WebCrypto alone: VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291, with the RFC 8188 header). No dependency; the RFC 8291
// Appendix A vector in __tests__/webpush.test.ts pins the encryption.

import { z } from "zod";
import { ConfigError, ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";

export interface VapidKeys {
  /** base64url uncompressed P-256 point (65 bytes). */
  publicKey: string;
  /** base64url private scalar `d`, or a JWK as JSON. */
  privateKey: string;
  /** `mailto:` contact the push services can reach. */
  subject: string;
}

export interface PushKeys {
  /** base64url uncompressed P-256 point from the browser's subscription. */
  p256dh: string;
  /** base64url 16-byte auth secret from the browser's subscription. */
  auth: string;
}

export interface EncryptOptions {
  /** Tests only: the RFC vector's application server key instead of a fresh one. */
  serverKey?: { publicKey: string; privateKey: string };
  /** Tests only: the RFC vector's salt instead of a random one. */
  salt?: Uint8Array<ArrayBuffer>;
}

/** Push services must accept records this size; one record holds the whole payload. */
export const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
/** Salt (16), record size (4), key id length (1) and the server's P-256 key (65). */
const HEADER_LENGTH = 16 + 4 + 1 + 65;
/**
 * RFC 8291 section 4 guarantees push services take a body of 4096 bytes, the
 * header included, so the plaintext (plus its delimiter and tag) gets what is
 * left: 3993 bytes.
 */
export const MAX_PUSH_PLAINTEXT_BYTES = 4096 - HEADER_LENGTH - 1 - TAG_LENGTH;
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60; // RFC 8292 allows at most 24 hours

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const p of parts) {
    length += p.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A P-256 JWK from an uncompressed public point and, optionally, the private scalar. */
function p256Jwk(publicKey: Uint8Array, d: string | undefined): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new ValidationError("Expected an uncompressed P-256 public key", {
      cause: undefined,
      where: "p256Jwk: public key",
    });
  }
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
  };
  if (d !== undefined) {
    jwk.d = d;
  }
  return jwk;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

async function serverKeyPair(
  options: EncryptOptions,
): Promise<{ privateKey: CryptoKey; publicRaw: Uint8Array<ArrayBuffer> }> {
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  const serverKey = options.serverKey;
  if (serverKey !== undefined) {
    const publicRaw = base64UrlDecode(serverKey.publicKey);
    const jwk = p256Jwk(publicRaw, serverKey.privateKey);
    const privateKey = await crypto.subtle.importKey("jwk", jwk, ecdh, false, ["deriveBits"]);
    return { privateKey, publicRaw };
  }
  const pair = await crypto.subtle.generateKey(ecdh, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicRaw };
}

/**
 * The aes128gcm request body for one push message (RFC 8291 section 3 and
 * RFC 8188): header (salt, record size, key id = server public key) followed
 * by a single record ending in the 0x02 delimiter.
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  keys: PushKeys,
  options: EncryptOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = base64UrlDecode(keys.p256dh);
  const authSecret = base64UrlDecode(keys.auth);
  if (authSecret.length !== 16) {
    throw new ValidationError("Subscription auth secret must be 16 bytes", {
      cause: undefined,
      where: "encryptPushPayload: subscription auth",
    });
  }
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new ValidationError("Subscription p256dh must be an uncompressed P-256 key", {
      cause: undefined,
      where: "encryptPushPayload: subscription p256dh",
    });
  }
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) {
    throw new ValidationError("Push payload is too large for one record", {
      cause: undefined,
      where: "encryptPushPayload: plaintext",
    });
  }

  let salt: Uint8Array<ArrayBuffer>;
  if (options.salt === undefined) {
    salt = crypto.getRandomValues(new Uint8Array(16));
  } else {
    salt = options.salt;
  }
  const server = await serverKeyPair(options);
  const uaKey = await crypto.subtle.importKey(
    "jwk",
    p256Jwk(uaPublic, undefined),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, server.privateKey, 256),
  );

  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, server.publicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      concat(plaintext, new Uint8Array([0x02])),
    ),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = server.publicRaw.length;
  return concat(header, server.publicRaw, ciphertext);
}

/** The members of a P-256 private JWK that importKey reads; an exporter's others are ignored. */
interface PrivateJwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
}

// A VAPID private key given as a JWK (from an exporter, or LONGLINES_VAPID_PRIVATE_KEY): loose,
// since exporters add key_ops, ext and alg. importKey checks the values.
const privateJwkSchema: z.ZodType<PrivateJwk> = z.looseObject({
  kty: z.string().optional(),
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
  d: z.string().optional(),
});

/** The private key's JWK text, parsed; ConfigError when it is not JSON. */
function parseJwkText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    // Only JSON.parse runs here, and it throws only SyntaxError.
    if (error instanceof SyntaxError) {
      throw new ConfigError("VAPID private key is not valid JWK JSON", { cause: error });
    }
    throw error;
  }
}

async function vapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const text = keys.privateKey.trim();
  let jwk: PrivateJwk;
  if (text.startsWith("{")) {
    jwk = parseWith(privateJwkSchema, parseJwkText(text), "vapidSigningKey: private key JWK");
  } else {
    if (base64UrlDecode(text).length !== 32) {
      throw new ConfigError("VAPID private key must be 32 bytes", { cause: undefined });
    }
    jwk = p256Jwk(base64UrlDecode(keys.publicKey), text);
  }
  // Drop the exporter's key_ops/ext so importKey's usages decide.
  return await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * The `Authorization` header for a push request (RFC 8292): an ES256 JWT for
 * the endpoint's origin, valid for 12 hours, plus the public key. A key that
 * cannot sign throws ConfigError or ValidationError (its shape), or the
 * DOMException WebCrypto or atob raised.
 */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now: Date,
): Promise<string> {
  function json(value: unknown): string {
    return base64UrlEncode(encoder.encode(JSON.stringify(value)));
  }
  const unsigned = `${json({ typ: "JWT", alg: "ES256" })}.${
    json({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now.getTime() / 1000) + VAPID_LIFETIME_SECONDS,
      sub: keys.subject,
    })
  }`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    await vapidSigningKey(keys),
    encoder.encode(unsigned),
  );
  return `vapid t=${unsigned}.${base64UrlEncode(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

/** A fresh VAPID keypair in the env format (scripts/generate-vapid-keys.ts prints it). */
export async function generateVapidKeys(subject: string): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const d = jwk.d;
  if (d === undefined || d === "") {
    throw new ValidationError("The runtime did not export the private key", {
      cause: undefined,
      where: "generateVapidKeys: exported private key",
    });
  }
  return { publicKey: base64UrlEncode(publicRaw), privateKey: d, subject };
}

/** The VAPID keys from Edge Function env, or undefined when any is missing. */
export function vapidKeysFromEnv(get: (name: string) => string | undefined): VapidKeys | undefined {
  const publicKey = trimmedOrUndefined(get("LONGLINES_VAPID_PUBLIC_KEY"));
  const privateKey = trimmedOrUndefined(get("LONGLINES_VAPID_PRIVATE_KEY"));
  const subject = trimmedOrUndefined(get("LONGLINES_VAPID_SUBJECT"));
  if (
    publicKey === undefined || publicKey === "" || privateKey === undefined ||
    privateKey === "" || subject === undefined || subject === ""
  ) {
    return undefined;
  }
  return { publicKey, privateKey, subject };
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.trim();
}
