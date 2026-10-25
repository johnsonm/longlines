// The one way external data becomes typed: parse it against its schema or throw ValidationError.
import { z } from "zod";
import { ValidationError } from "./errors.ts";

/** One line per issue, "<path>: <message>", with "(root)" for the input itself. */
function issueLines(error: z.ZodError): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    let path = "(root)";
    if (issue.path.length > 0) {
      path = issue.path.map((key) => String(key)).join(".");
    }
    lines.push(`${path}: ${issue.message}`);
  }
  return lines.join("; ");
}

/**
 * Parses raw against schema and returns the typed value. `where` names the reader and the input,
 * "<function>: <input>"; it heads the message and is kept on the error. The ZodError is the cause.
 */
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown, where: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${where}: ${issueLines(result.error)}`, {
      cause: result.error,
      where: where,
    });
  }
  return result.data;
}
