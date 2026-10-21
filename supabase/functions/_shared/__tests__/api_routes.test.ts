import { assertEquals } from "@std/assert";
import {
  apiPath,
  checkBody,
  matchRoute,
  MAX_LIST_ITEMS,
  numberSurvivesParse,
  parseBody,
  type Route,
  routeArgs,
  ROUTES,
} from "../api/routes.ts";

const ID = "0e7db3d0-52fa-4690-8f4a-79e468d6cf67";

function route(method: string, path: string): Route {
  const match = matchRoute(method, path);
  if (match.kind !== "route") throw new Error(`${method} ${path} did not match`);
  return match.route;
}

Deno.test("apiPath takes the path after the function name", () => {
  assertEquals(apiPath("/api/v1/connections"), "/v1/connections");
  assertEquals(apiPath("/functions/v1/api/v1/groups/"), "/v1/groups");
  assertEquals(apiPath("/api"), "");
  assertEquals(apiPath("/other/v1/connections"), null);
  assertEquals(apiPath("/apix/v1"), null);
});

Deno.test("matchRoute finds each route with its id", () => {
  const match = matchRoute("GET", `/v1/connections/${ID.toUpperCase()}`);
  assertEquals(match.kind === "route" && [match.route.op, match.id], ["get_subscription", ID]);
  assertEquals(route("POST", `/v1/groups/${ID}/members`).op, "add_group_members");
  assertEquals(route("POST", `/v1/groups/${ID}/members/remove`).op, "remove_group_members");
  assertEquals(matchRoute("POST", `/v1/connections/${ID}/callsigns`), { kind: "not_found" });
  assertEquals(route("POST", `/v1/destinations/${ID}/test`).op, "send_test");
  assertEquals(route("GET", "/v1/destinations").op, "list_destinations");
});

Deno.test("matchRoute separates unknown paths from wrong methods", () => {
  assertEquals(matchRoute("GET", "/v1/nope"), { kind: "not_found" });
  assertEquals(matchRoute("GET", "/v1/connections/not-a-uuid"), { kind: "not_found" });
  // Subscriptions are connections to API clients; the old paths are gone, not aliased.
  assertEquals(matchRoute("GET", "/v1/subscriptions"), { kind: "not_found" });
  assertEquals(matchRoute("GET", ""), { kind: "not_found" });
  assertEquals(matchRoute("PUT", `/v1/groups/${ID}`), {
    kind: "method_not_allowed",
    allow: ["GET", "PATCH", "DELETE"],
  });
});

Deno.test("only GET routes are readable with a read token", () => {
  for (const [method, path, r] of ROUTES) {
    assertEquals(r.scope, method === "GET" ? "read" : "write", `${method} ${path}`);
  }
});

Deno.test("creates answer 201 and everything else 200", () => {
  const created = ROUTES.filter(([, , r]) => r.status === 201).map(([m, p]) => `${m} ${p}`);
  assertEquals(created, ["POST /v1/destinations", "POST /v1/connections", "POST /v1/groups"]);
});

// api_call's allowlist is the other half of the route table: an op missing
// there fails at runtime with "Unknown operation.", and a scope that differs
// would make SQL refuse what the handler allowed (or the reverse).
Deno.test("every routed op is in api_call's allowlist with the same scope", () => {
  const dir = new URL("../../../migrations/", import.meta.url);
  const sql = [...Deno.readDirSync(dir)].map((e) => e.name).sort()
    .map((name) => Deno.readTextFileSync(new URL(name, dir)))
    .filter((text) => text.includes("function public.api_call("))
    .at(-1) ?? "";
  const listed = (scope: string): string[] => {
    const block = new RegExp(`when p_op in \\(([^)]*)\\)\\s*then '${scope}'`).exec(sql)?.[1] ?? "";
    return [...block.matchAll(/'(\w+)'/g)].map((m) => m[1] ?? "");
  };
  const sqlOps = new Map([
    ...listed("read").map((op) => [op, "read"] as const),
    ...listed("write").map((op) => [op, "write"] as const),
  ]);
  const routed = ROUTES.filter(([, , r]) => r.op !== "send_test");
  for (const [method, path, r] of routed) {
    assertEquals(sqlOps.get(r.op), r.scope, `${method} ${path} -> ${r.op}`);
  }
  assertEquals(new Set(routed.map(([, , r]) => r.op)).size, sqlOps.size, "unrouted SQL ops");
});

Deno.test("checkBody wants lists of strings within the cap", () => {
  const r = route("POST", "/v1/connections");
  assertEquals(checkBody(r, { sources: ["pota"], destinations: [] }), null);
  assertEquals(checkBody(r, { sources: "pota" }), "sources must be a list of strings.");
  assertEquals(checkBody(r, { destinations: [20] }), "destinations must be a list of strings.");
  const many = Array<string>(MAX_LIST_ITEMS + 1).fill("W1AW");
  assertEquals(
    checkBody(route("POST", `/v1/groups/${ID}/members`), { callsigns: many }),
    "callsigns can hold at most 2,000 items per request.",
  );
  assertEquals(
    checkBody(route("PATCH", `/v1/groups/${ID}`), { callsigns: "W1AW" }),
    "callsigns must be a list of strings.",
  );
});

Deno.test("checkBody refuses a null list, which SQL can't read as empty", () => {
  assertEquals(
    checkBody(route("POST", "/v1/connections"), { sources: null }),
    "sources must be a list of strings.",
  );
  assertEquals(
    checkBody(route("PATCH", `/v1/connections/${ID}`), { destinations: null }),
    "destinations must be a list of strings.",
  );
  assertEquals(
    checkBody(route("POST", "/v1/groups"), { name: "Club", callsigns: null }),
    "callsigns must be a list of strings.",
  );
});

Deno.test("checkBody checks scalar types and lets null through", () => {
  const sub = route("PATCH", `/v1/connections/${ID}`);
  assertEquals(
    checkBody(sub, { name: null, enabled: false, quiet_minutes: 30 }),
    null,
  );
  assertEquals(checkBody(sub, { name: ["NC"] }), "name must be a string.");
  assertEquals(checkBody(sub, { enabled: "yes" }), "enabled must be a boolean.");
  assertEquals(checkBody(sub, { quiet_minutes: "30" }), "quiet_minutes must be a number.");
  // Infinity (1e400 in the JSON) would be sent on as null and keep the old value.
  assertEquals(
    checkBody(sub, { quiet_minutes: JSON.parse("1e400") }),
    "quiet_minutes must be a number.",
  );
  // Which numbers are allowed is save_subscription's call; its message names them.
  for (const n of [30.5, 7, 2 ** 31, -(2 ** 31)]) {
    assertEquals(checkBody(sub, { quiet_minutes: n }), null, String(n));
  }
  const dest = route("PATCH", `/v1/destinations/${ID}`);
  assertEquals(checkBody(dest, { name: { x: 1 } }), "name must be a string.");
  assertEquals(checkBody(dest, { enabled: false, name: null }), null);
  assertEquals(checkBody(dest, { enabled: "no" }), "enabled must be a boolean.");
  assertEquals(
    checkBody(route("POST", "/v1/destinations"), { enabled: "no" }),
    null,
    "POST has no enabled",
  );
  assertEquals(
    checkBody(route("POST", "/v1/destinations"), { type: "discord", name: "Club", url: 5 }),
    "url must be a string.",
  );
  assertEquals(checkBody(route("POST", "/v1/groups"), { name: 5 }), "name must be a string.");
  assertEquals(checkBody(route("PATCH", `/v1/groups/${ID}`), { name: null }), null);
});

Deno.test("numberSurvivesParse refuses what a double would round", () => {
  for (
    const s of [
      "0",
      "-0",
      "30",
      "30.0",
      "1e1",
      "1.5E+2",
      "0.1",
      "123456789012345",
      "1e-300",
      "1e308",
    ]
  ) {
    assertEquals(numberSurvivesParse(s), true, s);
  }
  for (const s of ["1e-400", "1e400", "5.0000000000000001", "1234567890123456", "1e-310", "x"]) {
    assertEquals(numberSurvivesParse(s), false, s);
  }
});

Deno.test("parseBody turns a rounded number into one checkBody refuses", () => {
  const sub = route("PATCH", `/v1/connections/${ID}`);
  for (const text of ['{"quiet_minutes": 1e-400}', '{"quiet_minutes": 5.0000000000000001}']) {
    const body = parseBody(text);
    assertEquals(body !== null && checkBody(sub, body), "quiet_minutes must be a number.", text);
  }
  assertEquals(parseBody('{"quiet_minutes": 30.0, "rules": [[{"values": [14074]}]]}'), {
    quiet_minutes: 30,
    rules: [[{ values: [14074] }]],
  });
  for (const text of ["[]", "null", "5", "{", ""]) assertEquals(parseBody(text), null, text);
});

Deno.test("checkBody requires callsigns on the add and remove routes", () => {
  for (
    const path of [
      `/v1/groups/${ID}/members`,
      `/v1/groups/${ID}/members/remove`,
    ]
  ) {
    assertEquals(
      checkBody(route("POST", path), { callsign: ["KN4XYZ"] }),
      "callsigns is required.",
      path,
    );
    assertEquals(
      checkBody(route("POST", path), { callsigns: null }),
      "callsigns must be a list of strings.",
      path,
    );
    // An empty list would do nothing and still succeed.
    assertEquals(
      checkBody(route("POST", path), { callsigns: [] }),
      "callsigns can't be empty.",
      path,
    );
    assertEquals(checkBody(route("POST", path), { callsigns: ["KN4XYZ"] }), null, path);
  }
  assertEquals(checkBody(route("PATCH", `/v1/groups/${ID}`), { name: "Club" }), null);
});

Deno.test("checkBody wants rules as a list and leaves its contents to SQL", () => {
  const rule = { field: "band", op: "is", values: ["20m"] };
  for (const r of [route("POST", "/v1/connections"), route("PATCH", `/v1/connections/${ID}`)]) {
    assertEquals(checkBody(r, { rules: [[rule], [{ field: "x" }]] }), null);
    assertEquals(checkBody(r, { rules: [] }), null);
    assertEquals(checkBody(r, { rules: rule }), "rules must be a list.");
    assertEquals(checkBody(r, { rules: null }), "rules must be a list.");
  }
});

Deno.test("routeArgs builds each input kind, the path id winning", () => {
  assertEquals(routeArgs(route("GET", `/v1/destinations/${ID}`), ID, {}), { id: ID });
  assertEquals(
    routeArgs(route("PATCH", `/v1/groups/${ID}`), ID, { id: "other", name: "Club" }),
    { id: ID, name: "Club" },
  );
  assertEquals(routeArgs(route("POST", "/v1/connections"), undefined, { name: "A" }), {
    body: { name: "A" },
  });
  assertEquals(routeArgs(route("PUT", `/v1/connections/${ID}`), ID, { name: "A" }), {
    id: ID,
    body: { name: "A" },
  });
});
