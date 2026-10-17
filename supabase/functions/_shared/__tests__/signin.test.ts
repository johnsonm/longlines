import { assertEquals, assertThrows } from "@std/assert";
import {
  GENERIC_SIGN_IN_ERROR,
  isEmailIdentifier,
  MAX_IDENTIFIER_LENGTH,
  MAX_PASSWORD_LENGTH,
  normalizeIdentifier,
  parseSignInBody,
  TOO_MANY_ATTEMPTS,
} from "../signin.ts";

Deno.test("normalizeIdentifier uppercases callsigns and lowercases emails", () => {
  assertEquals(normalizeIdentifier("  kk4pwj "), "KK4PWJ");
  assertEquals(normalizeIdentifier(" Brad@Example.com "), "brad@example.com");
});

Deno.test("isEmailIdentifier keys on the @ sign", () => {
  assertEquals(isEmailIdentifier("a@b.c"), true);
  assertEquals(isEmailIdentifier("KK4PWJ"), false);
});

Deno.test("parseSignInBody requires non-empty identifier and password strings", () => {
  assertEquals(parseSignInBody({ identifier: "kk4pwj", password: "hunter22" }), {
    identifier: "kk4pwj",
    password: "hunter22",
  });
  assertThrows(() => parseSignInBody({ identifier: "", password: "x" }));
  assertThrows(() => parseSignInBody({ identifier: "x" }));
  assertThrows(() => parseSignInBody(null));
  assertThrows(() => parseSignInBody({ identifier: 5, password: "x" }));
});

Deno.test("parseSignInBody caps the identifier and password lengths", () => {
  const email = `${"a".repeat(MAX_IDENTIFIER_LENGTH - 6)}@b.com`;
  assertEquals(
    parseSignInBody({ identifier: ` ${email} `, password: "x" }).identifier,
    ` ${email} `,
  );
  assertThrows(() => parseSignInBody({ identifier: `a${email}`, password: "x" }));
  const longest = "p".repeat(MAX_PASSWORD_LENGTH);
  assertEquals(parseSignInBody({ identifier: "kk4pwj", password: longest }).password, longest);
  assertThrows(() => parseSignInBody({ identifier: "kk4pwj", password: `${longest}p` }));
});

Deno.test("the rate-limit message does not say the credentials are wrong", () => {
  assertEquals(TOO_MANY_ATTEMPTS.includes(GENERIC_SIGN_IN_ERROR), false);
  assertEquals(/match/.test(TOO_MANY_ATTEMPTS), false);
});
