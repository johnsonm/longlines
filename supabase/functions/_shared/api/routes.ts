// The management API's routes (docs/API.md): method and path to an api_call
// operation, the scope it needs and the arguments it receives. Pure; the SQL
// side (api_call) repeats the scope check and owns all validation beyond the
// shape checks here.

export type Scope = "read" | "write";

export type JsonObject = Record<string, unknown>;

// "integer" is a JSON number that fits Postgres's int: SQL casts it with ::int, which fails on a
// fraction or overflow with a Postgres message, and JSON.stringify would send Infinity on as null.
type Scalar = "string" | "boolean" | "integer";

export interface Route {
  /** An api_call operation, or "send_test", which the handler runs itself. */
  op: string;
  scope: Scope;
  /** Where the arguments come from: none, the JSON body's fields, or the body wrapped as `body`. */
  input: "none" | "fields" | "body";
  /** Keys that, when present in the body, must be arrays of strings. */
  arrays?: readonly string[];
  /** Scalar keys and their JSON type. Null is allowed: SQL reads it as left out. */
  scalars?: Readonly<Record<string, Scalar>>;
  /** Keys the body must have. Without them an add or remove would do nothing and still succeed. */
  required?: readonly string[];
  /** 201 for creates, 200 otherwise. */
  status: 200 | 201;
}

export type RouteMatch =
  | { kind: "route"; route: Route; id: string | undefined }
  | { kind: "not_found" }
  | { kind: "method_not_allowed"; allow: string[] };

/** Most strings one list in a request may hold. A group holds at most 1,000 calls, which SQL enforces. */
export const MAX_LIST_ITEMS = 2000;

const SUBSCRIPTION_ARRAYS = ["sources", "bands", "modes", "callsigns", "destinations", "group_ids"];
const CALLSIGN_ARRAYS = ["callsigns"];

const read = (op: string): Route => ({ op, scope: "read", input: "none", status: 200 });

const write = (
  op: string,
  input: Route["input"] = "none",
  more: Partial<Pick<Route, "arrays" | "scalars" | "required" | "status">> = {},
): Route => ({ op, scope: "write", input, status: 200, ...more });

const SUB = {
  arrays: SUBSCRIPTION_ARRAYS,
  scalars: { name: "string", reference: "string", enabled: "boolean", quiet_minutes: "integer" },
} as const;
const DEST = { scalars: { type: "string", name: "string", url: "string" } } as const;
const GROUP = { arrays: CALLSIGN_ARRAYS, scalars: { name: "string" } } as const;
const CALLS = { arrays: CALLSIGN_ARRAYS, required: CALLSIGN_ARRAYS };
const CREATED = { status: 201 } as const;

// deno-fmt-ignore
export const ROUTES: ReadonlyArray<readonly [string, string, Route]> = [
  ["GET",    "/v1/destinations",                   read("list_destinations")],
  ["POST",   "/v1/destinations",                   write("create_destination", "fields", { ...DEST, ...CREATED })],
  ["GET",    "/v1/destinations/:id",               read("get_destination")],
  ["PATCH",  "/v1/destinations/:id",               write("update_destination", "fields", DEST)],
  ["DELETE", "/v1/destinations/:id",               write("delete_destination")],
  ["POST",   "/v1/destinations/:id/rotate-secret", write("rotate_signing_secret")],
  ["POST",   "/v1/destinations/:id/test",          write("send_test")],

  ["GET",    "/v1/subscriptions",                  read("list_subscriptions")],
  ["POST",   "/v1/subscriptions",                  write("create_subscription", "body", { ...SUB, ...CREATED })],
  ["GET",    "/v1/subscriptions/:id",              read("get_subscription")],
  ["PUT",    "/v1/subscriptions/:id",              write("replace_subscription", "body", SUB)],
  ["PATCH",  "/v1/subscriptions/:id",              write("patch_subscription", "body", SUB)],
  ["DELETE", "/v1/subscriptions/:id",              write("delete_subscription")],
  ["POST",   "/v1/subscriptions/:id/callsigns",    write("add_subscription_callsigns", "fields", CALLS)],
  ["POST",   "/v1/subscriptions/:id/callsigns/remove", write("remove_subscription_callsigns", "fields", CALLS)],

  ["GET",    "/v1/groups",                         read("list_groups")],
  ["POST",   "/v1/groups",                         write("create_group", "fields", { ...GROUP, ...CREATED })],
  ["GET",    "/v1/groups/:id",                     read("get_group")],
  ["PATCH",  "/v1/groups/:id",                     write("update_group", "fields", GROUP)],
  ["DELETE", "/v1/groups/:id",                     write("delete_group")],
  ["POST",   "/v1/groups/:id/members",             write("add_group_members", "fields", CALLS)],
  ["POST",   "/v1/groups/:id/members/remove",      write("remove_group_members", "fields", CALLS)],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The API path from a request URL's pathname, from "/v1" on, or null when the
 * pathname is not under the function. Hosted requests arrive as "/api/v1/…";
 * the "/functions/v1" prefix is accepted too.
 */
export function apiPath(pathname: string): string | null {
  const match = /^(?:\/functions\/v1)?\/api(\/.*)?$/.exec(pathname);
  if (!match) return null;
  return (match[1] ?? "").replace(/\/+$/, "");
}

/** The route for a method and API path, with the path's id when it has one. */
export function matchRoute(method: string, path: string): RouteMatch {
  const segments = path.split("/");
  const allow: string[] = [];
  for (const [routeMethod, pattern, route] of ROUTES) {
    const parts = pattern.split("/");
    if (parts.length !== segments.length) continue;
    let id: string | undefined;
    const fits = parts.every((part, i) => {
      const segment = segments[i] ?? "";
      if (part !== ":id") return part === segment;
      id = segment;
      return UUID.test(segment);
    });
    if (!fits) continue;
    if (routeMethod === method) return { kind: "route", route, id: id?.toLowerCase() };
    allow.push(routeMethod);
  }
  return allow.length > 0 ? { kind: "method_not_allowed", allow } : { kind: "not_found" };
}

const isInt4 = (v: unknown) =>
  Number.isInteger(v) && (v as number) >= -(2 ** 31) && (v as number) < 2 ** 31;

/** A message for the first body field of the wrong shape, or null when the body is acceptable. */
export function checkBody(route: Route, body: JsonObject): string | null {
  for (const key of route.required ?? []) {
    if (body[key] === undefined) return `${key} is required.`;
  }
  // A null list is refused: SQL would fail on it with a Postgres message rather than read it as empty.
  for (const key of route.arrays ?? []) {
    const value = body[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      return `${key} must be a list of strings.`;
    }
    if (value.length > MAX_LIST_ITEMS) {
      return `${key} can hold at most ${MAX_LIST_ITEMS.toLocaleString("en-US")} items per request.`;
    }
  }
  for (const [key, type] of Object.entries(route.scalars ?? {})) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (type === "integer" ? isInt4(value) : typeof value === type) continue;
    return `${key} must be ${type === "integer" ? "an integer" : `a ${type}`}.`;
  }
  return null;
}

/** The api_call arguments for a matched route. The path's id always wins over an id in the body. */
export function routeArgs(route: Route, id: string | undefined, body: JsonObject): JsonObject {
  const withId = id === undefined ? {} : { id };
  switch (route.input) {
    case "none":
      return withId;
    case "fields":
      return { ...body, ...withId };
    case "body":
      return { ...withId, body };
  }
}
