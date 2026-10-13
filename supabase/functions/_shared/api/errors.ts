// Maps an error from api_call to an HTTP status. The SQL functions raise
// user-facing messages with SQLSTATE P0001 (plain `raise exception`); the
// message decides the status. Bad input that Postgres rejects itself (a value
// of the wrong type, a check constraint) is the caller's fault too.

export interface DbError {
  message: string;
  code?: string;
}

/** Postgres error classes caused by the request's values: data exceptions (22) and integrity violations (23). */
const BAD_INPUT_CLASSES = ["22", "23"];

export function errorStatus(error: DbError): number {
  if (error.code === "P0001") {
    if (error.message === "Token not found.") return 401;
    if (error.message === "This token is read only.") return 403;
    if (error.message.endsWith(" not found.")) return 404;
    if (error.message === "Remove it from its subscriptions first.") return 409;
    return 400;
  }
  if (BAD_INPUT_CLASSES.includes(error.code?.slice(0, 2) ?? "")) return 400;
  return 500;
}
