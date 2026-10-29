// Pure helpers for the sign-in function.

import { z } from "zod";
import { parseWith } from "./validate.ts";

export const GENERIC_SIGN_IN_ERROR = "That email and password don't match.";
/** For an identifier that is not an email: accounts may share a callsign, so it names no one account. */
export const SIGN_IN_WITH_EMAIL = "Sign in with your email address.";
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

/** Trimmed and lowercased, as Auth compares emails. */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

// The web app's request body (signIn in web/src/lib/api.ts): strict. The identifier is checked
// trimmed but kept as sent; normalizeIdentifier trims it.
const signInBodySchema: z.ZodType<SignInBody> = z.strictObject({
  identifier: z.string({ error: "identifier required" })
    .refine((identifier) => identifier.trim() !== "", { error: "identifier required" })
    .refine((identifier) => identifier.trim().length <= MAX_IDENTIFIER_LENGTH, {
      error: "identifier too long",
    }),
  password: z.string({ error: "password required" })
    .min(1, { error: "password required" })
    .max(MAX_PASSWORD_LENGTH, { error: "password too long" }),
}, { error: "expected an object with only identifier and password" });

/** The sign-in request body. Throws ValidationError naming the first field that is wrong. */
export function parseSignInBody(body: unknown): SignInBody {
  return parseWith(signInBodySchema, body, "parseSignInBody: request body");
}
