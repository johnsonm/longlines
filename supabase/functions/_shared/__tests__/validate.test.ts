import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { z } from "zod";
import { ValidationError } from "../errors.ts";
import { parseWith } from "../validate.ts";

interface Body {
  call: string;
  count: number;
}

const bodySchema: z.ZodType<Body> = z.strictObject({ call: z.string(), count: z.number() });

interface Feed {
  id: number;
}

// Third-party data: unknown keys are allowed and kept.
const feedSchema: z.ZodType<Feed> = z.looseObject({ id: z.number() });

Deno.test("parseWith returns the parsed value", function (): void {
  const raw: unknown = JSON.parse('{"call":"K1ABC","count":2}');
  assertEquals(parseWith(bodySchema, raw, "test: body"), { call: "K1ABC", count: 2 });
});

Deno.test("parseWith throws ValidationError with the ZodError as cause", function (): void {
  const raw: unknown = { call: "K1ABC", count: "2" };
  const error = assertThrows(() => parseWith(bodySchema, raw, "test: body"), ValidationError);
  assertEquals(error.where, "test: body");
  assertInstanceOf(error.cause, z.ZodError);
  assertEquals(
    error.message,
    "test: body: count: Invalid input: expected number, received string",
  );
});

Deno.test("parseWith names the root and every failing path", function (): void {
  assertEquals(
    assertThrows(() => parseWith(bodySchema, null, "test: body"), ValidationError).message,
    "test: body: (root): Invalid input: expected object, received null",
  );
  const message = assertThrows(
    () => parseWith(z.array(bodySchema), [{ call: 1, count: 1 }, { call: "A" }], "test: list"),
    ValidationError,
  ).message;
  assertEquals(
    message,
    "test: list: 0.call: Invalid input: expected string, received number; " +
      "1.count: Invalid input: expected number, received undefined",
  );
});

Deno.test("a strict schema refuses unknown keys and a loose one keeps them", function (): void {
  const raw: unknown = { call: "K1ABC", count: 2, extra: true };
  assertThrows(() => parseWith(bodySchema, raw, "test: body"), ValidationError);
  const kept: unknown = parseWith(feedSchema, { id: 1, extra: true }, "test: feed");
  assertEquals(kept, { id: 1, extra: true });
});
