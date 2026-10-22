// Maps an error from api_call to an HTTP status by its SQLSTATE, never its message, so rewording
// a message in SQL can't change a status. api_call raises its own errors with custom codes (LL401
// token, LL403 read only, LL404 the path's resource is missing, LL409 in use); every other
// user-facing message is a plain `raise exception` (P0001) and is a 400. Bad input that Postgres
// rejects itself (a value of the wrong type, a check constraint) is the caller's fault too.

export interface DbError {
  message: string;
  code?: string;
}

const CODES: Readonly<Record<string, number>> = {
  LL401: 401,
  LL403: 403,
  LL404: 404,
  LL409: 409,
  P0001: 400,
};

/** Postgres error classes caused by the request's values: data exceptions (22) and integrity violations (23). */
const BAD_INPUT_CLASSES = ["22", "23"];

export function errorStatus(error: DbError): number {
  const status = CODES[error.code ?? ""];
  if (status !== undefined) return status;
  if (BAD_INPUT_CLASSES.includes(error.code?.slice(0, 2) ?? "")) return 400;
  return 500;
}
