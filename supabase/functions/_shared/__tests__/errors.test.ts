import { assertEquals, assertInstanceOf, assertStrictEquals } from "@std/assert";
import { ConfigError, FunctionCallError, ValidationError } from "../errors.ts";

Deno.test("ValidationError keeps its message, cause and where", function (): void {
  const cause = new Error("bad input");
  const error = new ValidationError("pota: feed", { cause: cause, where: "parseFeed: body" });
  assertInstanceOf(error, Error);
  assertEquals(error.name, "ValidationError");
  assertEquals(error.message, "pota: feed");
  assertStrictEquals(error.cause, cause);
  assertEquals(error.where, "parseFeed: body");
});

Deno.test("FunctionCallError keeps its message, cause and status", function (): void {
  const error = new FunctionCallError("ingest-rbn answered 502", { cause: undefined, status: 502 });
  assertInstanceOf(error, Error);
  assertEquals(error.name, "FunctionCallError");
  assertEquals(error.message, "ingest-rbn answered 502");
  assertEquals(error.cause, undefined);
  assertEquals(error.status, 502);
});

Deno.test("ConfigError keeps its message and cause", function (): void {
  const cause = new RangeError("not a number");
  const error = new ConfigError("SENDER_POLL_MS is not a number", { cause: cause });
  assertInstanceOf(error, Error);
  assertEquals(error.name, "ConfigError");
  assertEquals(error.message, "SENDER_POLL_MS is not a number");
  assertStrictEquals(error.cause, cause);
});

Deno.test("each class is told apart with instanceof", function (): void {
  const errors: Error[] = [
    new ValidationError("v", { cause: undefined, where: "w" }),
    new FunctionCallError("f", { cause: undefined, status: 500 }),
    new ConfigError("c", { cause: undefined }),
  ];
  const kinds: string[] = [];
  for (const error of errors) {
    if (error instanceof ValidationError) {
      kinds.push(`validation ${error.where}`);
    } else if (error instanceof FunctionCallError) {
      kinds.push(`call ${String(error.status)}`);
    } else if (error instanceof ConfigError) {
      kinds.push("config");
    }
  }
  assertEquals(kinds, ["validation w", "call 500", "config"]);
});
