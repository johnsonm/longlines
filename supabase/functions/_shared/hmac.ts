// HMAC-SHA-256 and hex encoding, shared by webhook signing
// (delivery/hmac.ts), the profile rate-limit key and content hashes.

const encoder = new TextEncoder();

/** Lowercase hex of a digest or MAC. */
export function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A signing key for hmacSha256Hex. Import it once when the secret is fixed for the process. */
export function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** HMAC-SHA-256 of the message as lowercase hex. */
export async function hmacSha256Hex(key: CryptoKey, message: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
