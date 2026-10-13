import { assertEquals } from "@std/assert";
import {
  apiPath,
  checkBody,
  matchRoute,
  MAX_LIST_ITEMS,
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
  assertEquals(apiPath("/api/v1/subscriptions"), "/v1/subscriptions");
  assertEquals(apiPath("/functions/v1/api/v1/groups/"), "/v1/groups");
  assertEquals(apiPath("/api"), "");
  assertEquals(apiPath("/other/v1/subscriptions"), null);
  assertEquals(apiPath("/apix/v1"), null);
});

Deno.test("matchRoute finds each route with its id", () => {
  const match = matchRoute("GET", `/v1/subscriptions/${ID.toUpperCase()}`);
  assertEquals(match.kind === "route" && [match.route.op, match.id], ["get_subscription", ID]);
  assertEquals(route("POST", `/v1/groups/${ID}/members`).op, "add_group_members");
  assertEquals(route("POST", `/v1/groups/${ID}/members/remove`).op, "remove_group_members");
  assertEquals(
    route("POST", `/v1/subscriptions/${ID}/callsigns/remove`).op,
    "remove_subscription_callsigns",
  );
  assertEquals(route("POST", `/v1/destinations/${ID}/test`).op, "send_test");
  assertEquals(route("GET", "/v1/destinations").op, "list_destinations");
});

Deno.test("matchRoute separates unknown paths from wrong methods", () => {
  assertEquals(matchRoute("GET", "/v1/nope"), { kind: "not_found" });
  assertEquals(matchRoute("GET", "/v1/subscriptions/not-a-uuid"), { kind: "not_found" });
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
  assertEquals(created, ["POST /v1/destinations", "POST /v1/subscriptions", "POST /v1/groups"]);
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
  const r = route("POST", "/v1/subscriptions");
  assertEquals(checkBody(r, { callsigns: ["W1AW"], sources: null }), null);
  assertEquals(checkBody(r, { callsigns: "W1AW" }), "callsigns must be a list of strings.");
  assertEquals(checkBody(r, { bands: [20] }), "bands must be a list of strings.");
  const many = Array<string>(MAX_LIST_ITEMS + 1).fill("W1AW");
  assertEquals(
    checkBody(route("POST", `/v1/groups/${ID}/members`), { callsigns: many }),
    "callsigns can hold at most 2,000 items per request.",
  );
  assertEquals(checkBody(route("POST", "/v1/groups"), { name: 5 }), null);
  assertEquals(
    checkBody(route("PATCH", `/v1/groups/${ID}`), { callsigns: "W1AW" }),
    "callsigns must be a list of strings.",
  );
});

Deno.test("routeArgs builds each input kind, the path id winning", () => {
  assertEquals(routeArgs(route("GET", `/v1/destinations/${ID}`), ID, {}), { id: ID });
  assertEquals(
    routeArgs(route("PATCH", `/v1/groups/${ID}`), ID, { id: "other", name: "Club" }),
    { id: ID, name: "Club" },
  );
  assertEquals(routeArgs(route("POST", "/v1/subscriptions"), undefined, { name: "A" }), {
    body: { name: "A" },
  });
  assertEquals(routeArgs(route("PUT", `/v1/subscriptions/${ID}`), ID, { name: "A" }), {
    id: ID,
    body: { name: "A" },
  });
});
