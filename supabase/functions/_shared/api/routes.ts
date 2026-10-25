// The management API's routes (docs/openapi.yaml): method and path to an api_call
// operation, the scope it needs and the arguments it receives. Pure; the SQL
// side (api_call) repeats the scope check and owns all validation beyond the
// shape checks here. API clients call subscriptions connections, so their
// routes are /v1/connections; the operations keep their names.

export type Scope = "read" | "write";

export type JsonObject = Record<string, unknown>;

// "number" is a finite JSON number that parsed exactly: JSON.parse reads 1e400 as Infinity, which
// JSON.stringify would send on as null (left out), and parseBody turns a number it would round
// (1e-400 into 0) into NaN. Which numbers are allowed is SQL's call (save_subscription names the
// allowed quiet_minutes), so a fraction or an out-of-range value gets SQL's message, not one here.
type Scalar = "string" | "boolean" | "number";

export interface Route {
  /** An api_call operation, or "send_test", which the handler runs itself. */
  op: string;
  scope: Scope;
  /** Where the arguments come from: none, the JSON body's fields, or the body wrapped as `body`. */
  input: "none" | "fields" | "body";
  /** Keys that, when present in the body, must be arrays of strings. */
  arrays?: readonly string[];
  /** Keys that, when present in the body, must be arrays; SQL checks what they hold. */
  lists?: readonly string[];
  /** Scalar keys and their JSON type. Null is allowed: SQL reads it as left out. */
  scalars?: Readonly<Record<string, Scalar>>;
  /** Lists the body must have, with at least one item. Without one an add or remove would do nothing and still succeed. */
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

const SUBSCRIPTION_ARRAYS = ["sources", "destinations"];
const CALLSIGN_ARRAYS = ["callsigns"];

function read(op: string): Route {
  return { op, scope: "read", input: "none", status: 200 };
}

function write(
  op: string,
  input: Route["input"],
  more: Partial<Pick<Route, "arrays" | "lists" | "scalars" | "required" | "status">>,
): Route {
  const route: Route = { op, scope: "write", input, status: 200 };
  if (more.arrays !== undefined) {
    route.arrays = more.arrays;
  }
  if (more.lists !== undefined) {
    route.lists = more.lists;
  }
  if (more.scalars !== undefined) {
    route.scalars = more.scalars;
  }
  if (more.required !== undefined) {
    route.required = more.required;
  }
  if (more.status !== undefined) {
    route.status = more.status;
  }
  return route;
}

// rules is a list of AND groups, each a list of rules; normalize_subscription_rules checks the rest.
const SUB = {
  arrays: SUBSCRIPTION_ARRAYS,
  lists: ["rules"],
  scalars: { name: "string", enabled: "boolean", quiet_minutes: "number" },
} as const;
const DEST = { scalars: { type: "string", name: "string", url: "string" } } as const;
const DEST_PATCH = { scalars: { name: "string", url: "string", enabled: "boolean" } } as const;
const GROUP = { arrays: CALLSIGN_ARRAYS, scalars: { name: "string" } } as const;
const CALLS = { arrays: CALLSIGN_ARRAYS, required: CALLSIGN_ARRAYS };
const CREATED = { status: 201 } as const;

// deno-fmt-ignore
export const ROUTES: ReadonlyArray<readonly [string, string, Route]> = [
  ["GET",    "/v1/destinations",                   read("list_destinations")],
  ["POST",   "/v1/destinations",                   write("create_destination", "fields", { scalars: DEST.scalars, status: CREATED.status })],
  ["GET",    "/v1/destinations/:id",               read("get_destination")],
  ["PATCH",  "/v1/destinations/:id",               write("update_destination", "fields", DEST_PATCH)],
  ["DELETE", "/v1/destinations/:id",               write("delete_destination", "none", {})],
  ["POST",   "/v1/destinations/:id/rotate-secret", write("rotate_signing_secret", "none", {})],
  ["POST",   "/v1/destinations/:id/test",          write("send_test", "none", {})],

  ["GET",    "/v1/connections",                    read("list_subscriptions")],
  ["POST",   "/v1/connections",                    write("create_subscription", "body", { arrays: SUB.arrays, lists: SUB.lists, scalars: SUB.scalars, status: CREATED.status })],
  ["GET",    "/v1/connections/:id",                read("get_subscription")],
  ["PUT",    "/v1/connections/:id",                write("replace_subscription", "body", SUB)],
  ["PATCH",  "/v1/connections/:id",                write("patch_subscription", "body", SUB)],
  ["DELETE", "/v1/connections/:id",                write("delete_subscription", "none", {})],

  ["GET",    "/v1/groups",                         read("list_groups")],
  ["POST",   "/v1/groups",                         write("create_group", "fields", { arrays: GROUP.arrays, scalars: GROUP.scalars, status: CREATED.status })],
  ["GET",    "/v1/groups/:id",                     read("get_group")],
  ["PATCH",  "/v1/groups/:id",                     write("update_group", "fields", GROUP)],
  ["DELETE", "/v1/groups/:id",                     write("delete_group", "none", {})],
  ["POST",   "/v1/groups/:id/members",             write("add_group_members", "fields", CALLS)],
  ["POST",   "/v1/groups/:id/members/remove",      write("remove_group_members", "fields", CALLS)],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string is a UUID in its usual hyphenated form, any case. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * The API path from a request URL's pathname, from "/v1" on, or null when the
 * pathname is not under the function. Hosted requests arrive as "/api/v1/…";
 * the "/functions/v1" prefix is accepted too.
 */
export function apiPath(pathname: string): string | null {
  const match = /^(?:\/functions\/v1)?\/api(\/.*)?$/.exec(pathname);
  if (match === null) {
    return null;
  }
  let rest = "";
  if (match[1] !== undefined && match[1] !== null) {
    rest = match[1];
  }
  return rest.replace(/\/+$/, "");
}

/** The route for a method and API path, with the path's id when it has one. */
export function matchRoute(method: string, path: string): RouteMatch {
  const segments = path.split("/");
  const allow: string[] = [];
  for (const entry of ROUTES) {
    const routeMethod = entry[0];
    const pattern = entry[1];
    const route = entry[2];
    const parts = pattern.split("/");
    if (parts.length !== segments.length) {
      continue;
    }
    let id: string | undefined;
    // Every part must fit its segment; stops at the first that doesn't, as every() did.
    let fits = true;
    let i = 0;
    for (const part of parts) {
      let segment = "";
      const value = segments[i];
      if (value !== undefined && value !== null) {
        segment = value;
      }
      i++;
      if (part !== ":id") {
        if (part !== segment) {
          fits = false;
          break;
        }
        continue;
      }
      id = segment;
      if (!isUuid(segment)) {
        fits = false;
        break;
      }
    }
    if (!fits) {
      continue;
    }
    if (routeMethod === method) {
      let lowered: string | undefined;
      if (id !== undefined && id !== null) {
        lowered = id.toLowerCase();
      }
      return { kind: "route", route, id: lowered };
    }
    allow.push(routeMethod);
  }
  if (allow.length > 0) {
    return { kind: "method_not_allowed", allow };
  }
  return { kind: "not_found" };
}

/** Each scalar type's test and the phrase its error message uses. */
const SCALARS: Readonly<Record<Scalar, { test: (v: unknown) => boolean; noun: string }>> = {
  string: { test: (v) => typeof v === "string", noun: "a string" },
  boolean: { test: (v) => typeof v === "boolean", noun: "a boolean" },
  number: { test: (v) => typeof v === "number" && Number.isFinite(v), noun: "a number" },
};

/** A message for the first body field of the wrong shape, or null when the body is acceptable. */
export function checkBody(route: Route, body: JsonObject): string | null {
  for (const key of keysOrNone(route.required)) {
    if (body[key] === undefined) {
      return `${key} is required.`;
    }
    if (Array.isArray(body[key]) && body[key].length === 0) {
      return `${key} can't be empty.`;
    }
  }
  // A null list is refused: SQL would fail on it with a Postgres message rather than read it as empty.
  for (const key of keysOrNone(route.arrays)) {
    const value = body[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      return `${key} must be a list of strings.`;
    }
    if (value.length > MAX_LIST_ITEMS) {
      return `${key} can hold at most ${MAX_LIST_ITEMS.toLocaleString("en-US")} items per request.`;
    }
  }
  for (const key of keysOrNone(route.lists)) {
    const value = body[key];
    if (value !== undefined && !Array.isArray(value)) {
      return `${key} must be a list.`;
    }
  }
  let scalars: Readonly<Record<string, Scalar>> = {};
  if (route.scalars !== undefined && route.scalars !== null) {
    scalars = route.scalars;
  }
  for (const entry of Object.entries(scalars)) {
    const key = entry[0];
    const type = entry[1];
    const value = body[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (SCALARS[type].test(value)) {
      continue;
    }
    return `${key} must be ${SCALARS[type].noun}.`;
  }
  return null;
}

/** A route's optional key list, or none when it is left out. */
function keysOrNone(keys: readonly string[] | undefined): readonly string[] {
  if (keys === undefined || keys === null) {
    return [];
  }
  return keys;
}

/**
 * Whether a JSON number's source text survives JSON.parse unchanged. A double holds any decimal of
 * at most 15 significant digits in the normal range exactly enough that JSON.stringify gives the
 * same value back; longer ones (5.0000000000000001) and tiny ones (1e-400, read as 0) are rounded,
 * and SQL would then judge a value the client never sent.
 */
export function numberSurvivesParse(source: string): boolean {
  const match = /^-?(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(source);
  if (match === null) {
    return false;
  }
  let fraction = "";
  if (match[2] !== undefined && match[2] !== null) {
    fraction = match[2];
  }
  // The pattern always captures the integer part; String() only satisfies the type.
  const digits = (String(match[1]) + fraction).replace(/^0+/, "").replace(/0+$/, "");
  if (digits === "") {
    return true;
  }
  const value = Math.abs(Number(source));
  return digits.length <= 15 && value >= 2.2250738585072014e-308 && value <= Number.MAX_VALUE;
}

/**
 * The body as a JSON object, or null when it is not one. A number JSON.parse would round becomes
 * NaN, which the scalar check refuses and JSON.stringify sends on as null rather than a rounded value.
 */
export function parseBody(text: string): JsonObject | null {
  let value: unknown;
  try {
    value = JSON.parse(text, exactNumbers);
  } catch {
    return null;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return null;
}

// The reviver's third argument (JSON.parse source text access) is missing from TypeScript's lib, and
// from runtimes too old to pass it, so it is read from the rest; without it a number is kept as
// parsed.
function exactNumbers(_key: string, value: unknown, ...rest: unknown[]): unknown {
  const context = rest[0];
  if (typeof value !== "number" || typeof context !== "object" || context === null) {
    return value;
  }
  if (!("source" in context) || typeof context.source !== "string") {
    return value;
  }
  if (numberSurvivesParse(context.source)) {
    return value;
  }
  return Number.NaN;
}

/** The api_call arguments for a matched route. The path's id always wins over an id in the body. */
export function routeArgs(route: Route, id: string | undefined, body: JsonObject): JsonObject {
  const withId: JsonObject = {};
  if (id !== undefined) {
    withId.id = id;
  }
  switch (route.input) {
    case "none":
      return withId;
    case "fields": {
      // fromEntries defines keys as the spread did, so a "__proto__" field stays a plain key.
      const args: JsonObject = Object.fromEntries(Object.entries(body));
      if (id !== undefined) {
        args.id = id;
      }
      return args;
    }
    case "body": {
      const args: JsonObject = {};
      if (id !== undefined) {
        args.id = id;
      }
      args.body = body;
      return args;
    }
  }
}
