// The error classes the Deno code throws. Every constructor takes the message and one context
// object whose `cause` is required: pass the caught error when wrapping, or undefined.

/** Context for an error that carries nothing but its cause. */
export interface ErrorContext {
  cause: unknown;
}

/** Context for a ValidationError: where the input came in. */
export interface ValidationErrorContext {
  cause: unknown;
  where: string;
}

/** Context for a FunctionCallError: the HTTP status the call answered. */
export interface FunctionCallErrorContext {
  cause: unknown;
  status: number;
}

/** External data did not match its schema (parseWith in validate.ts throws it). */
export class ValidationError extends Error {
  /** "<function>: <input>", as passed to parseWith. */
  readonly where: string;

  constructor(message: string, context: ValidationErrorContext) {
    super(message, { cause: context.cause });
    this.name = "ValidationError";
    this.where = context.where;
  }
}

/** A call to another function or HTTP service answered with a status it should not have. */
export class FunctionCallError extends Error {
  readonly status: number;

  constructor(message: string, context: FunctionCallErrorContext) {
    super(message, { cause: context.cause });
    this.name = "FunctionCallError";
    this.status = context.status;
  }
}

/** The process or function was started with missing or invalid configuration. */
export class ConfigError extends Error {
  constructor(message: string, context: ErrorContext) {
    super(message, { cause: context.cause });
    this.name = "ConfigError";
  }
}
