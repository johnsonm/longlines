// Pure helpers for the sign-in function.

export const GENERIC_SIGN_IN_ERROR = "That callsign or email and password don't match.";
/** Past the limit; says nothing about whether the credentials were right. */
export const TOO_MANY_ATTEMPTS = "Too many attempts. Try again in a few minutes.";
/** Longest identifier accepted: an email address is at most 254 characters. */
export const MAX_IDENTIFIER_LENGTH = 254;
/** Longest password accepted; Auth's own limit is far below it. */
export const MAX_PASSWORD_LENGTH = 1024;

export interface SignInBody {
  identifier: string;
  password: string;
}

export function isEmailIdentifier(identifier: string): boolean {
  return identifier.includes("@");
}

/** Emails lowercase, callsigns uppercase, both trimmed. */
export function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  return isEmailIdentifier(trimmed) ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

export function parseSignInBody(body: unknown): SignInBody {
  if (typeof body !== "object" || body === null) throw new Error("expected an object");
  const { identifier, password } = body as Record<string, unknown>;
  if (typeof identifier !== "string" || identifier.trim() === "") {
    throw new Error("identifier required");
  }
  if (identifier.trim().length > MAX_IDENTIFIER_LENGTH) throw new Error("identifier too long");
  if (typeof password !== "string" || password === "") throw new Error("password required");
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error("password too long");
  return { identifier, password };
}
