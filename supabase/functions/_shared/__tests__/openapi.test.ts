// docs/openapi.yaml is the API's published reference; the route table is what
// the handler serves. These tests keep the two describing the same API: the same
// operations, scopes and statuses, and the same body fields with the shapes
// checkBody enforces.

import { assert, assertEquals } from "@std/assert";
import { parse } from "@std/yaml";
import { type Route, ROUTES } from "../api/routes.ts";

type Node = Record<string, unknown>;

const spec = parse(
  Deno.readTextFileSync(new URL("../../../../docs/openapi.yaml", import.meta.url)),
) as Node;

const METHODS = ["get", "put", "post", "patch", "delete"];

/** A node, with a local $ref followed. */
function resolve(node: unknown): Node {
  let current = node as Node;
  while (typeof current.$ref === "string") {
    let at: unknown = spec;
    for (const key of current.$ref.replace(/^#\//, "").split("/")) {
      at = (at as Node)[key];
    }
    current = at as Node;
  }
  return current;
}

/** A schema's properties and required keys, merged across allOf and oneOf. */
function flatten(node: unknown): { properties: Node; required: Set<string> } {
  const schema = resolve(node);
  const properties: Node = {};
  Object.assign(properties, schema.properties as Node | undefined);
  const requiredKeys = schema.required as string[] | undefined;
  const required = new Set<string>();
  if (requiredKeys !== undefined && requiredKeys !== null) {
    for (const key of requiredKeys) {
      required.add(key);
    }
  }
  let oneOf = schema.oneOf as unknown[] | undefined;
  if (oneOf === undefined || oneOf === null) {
    oneOf = [];
  }
  let allOf = schema.allOf as unknown[] | undefined;
  if (allOf === undefined || allOf === null) {
    allOf = [];
  }
  for (const part of allOf.concat(oneOf)) {
    const inner = flatten(part);
    Object.assign(properties, inner.properties);
    for (const key of inner.required) {
      required.add(key);
    }
  }
  // A key every branch of a oneOf requires is required; one only some branches need is not.
  for (const key of required) {
    if (oneOf.length > 0 && !oneOf.every((b) => flatten(b).required.has(key))) {
      required.delete(key);
    }
  }
  return { properties, required };
}

function types(node: unknown): string[] {
  const schema = resolve(node);
  if ("const" in schema) {
    return [typeof schema.const];
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    return type;
  }
  if (typeof type === "string") {
    return [type];
  }
  return [];
}

interface Operation {
  key: string;
  op: Node;
}

function operations(): Operation[] {
  const paths = spec.paths as Record<string, Node>;
  const found: Operation[] = [];
  for (const entry of Object.entries(paths)) {
    const path = entry[0];
    const item = entry[1];
    for (const m of METHODS) {
      if (m in item) {
        found.push({
          key: `${m.toUpperCase()} /v1${path.replaceAll("{id}", ":id")}`,
          op: item[m] as Node,
        });
      }
    }
  }
  return found;
}

function routeFor(key: string): Route {
  const found = ROUTES.find((e) => `${e[0]} ${e[1]}` === key);
  if (found === undefined) {
    throw new Error(`${key} is not routed`);
  }
  return found[2];
}

Deno.test("the spec has exactly the routed operations", function (): void {
  assertEquals(
    operations().map((o) => o.key).sort(),
    ROUTES.map((e) => `${e[0]} ${e[1]}`).sort(),
  );
});

Deno.test(
  "operation ids are the api_call ops, with connections for subscriptions",
  function (): void {
    for (const o of operations()) {
      assertEquals(
        o.op.operationId,
        routeFor(o.key).op.replace("subscription", "connection"),
        o.key,
      );
    }
  },
);

Deno.test("each operation needs the route's scope", function (): void {
  for (const o of operations()) {
    let declared = o.op.security;
    if (declared === undefined || declared === null) {
      declared = spec.security;
    }
    const security = declared as Record<string, string[]>[];
    assertEquals(security, [{ apiToken: [routeFor(o.key).scope] }], o.key);
  }
});

Deno.test("each operation's success status is the route's", function (): void {
  for (const o of operations()) {
    const success = Object.keys(o.op.responses as Node).filter((s) => s.startsWith("2"));
    assertEquals(success, [String(routeFor(o.key).status)], o.key);
  }
});

Deno.test(
  "request bodies have the fields checkBody checks, with the same shapes",
  function (): void {
    for (const o of operations()) {
      const key = o.key;
      const op = o.op;
      const route = routeFor(key);
      if (route.input === "none") {
        assertEquals(op.requestBody, undefined, key);
        continue;
      }
      const body = resolve(op.requestBody);
      const content = body.content as Record<string, Node>;
      const json = content["application/json"];
      let schema: unknown;
      if (json !== undefined && json !== null) {
        schema = json.schema;
      }
      const flat = flatten(schema);
      const properties = flat.properties;
      const required = flat.required;

      let arrays: readonly string[] = [];
      if (route.arrays !== undefined && route.arrays !== null) {
        arrays = route.arrays;
      }
      let lists: readonly string[] = [];
      if (route.lists !== undefined && route.lists !== null) {
        lists = route.lists;
      }
      let scalars: [string, string][] = [];
      if (route.scalars !== undefined && route.scalars !== null) {
        scalars = Object.entries(route.scalars);
      }
      assertEquals(
        Object.keys(properties).sort(),
        arrays.concat(lists, scalars.map((e) => e[0])).sort(),
        key,
      );
      for (const name of arrays) {
        const prop = resolve(properties[name]);
        assertEquals(types(prop), ["array"], `${key} ${name}`);
        assertEquals(types(prop.items), ["string"], `${key} ${name} items`);
      }
      for (const name of lists) {
        assertEquals(types(properties[name]), ["array"], `${key} ${name}`);
      }
      for (const entry of scalars) {
        const name = entry[0];
        const scalar = entry[1];
        let allowed = [scalar];
        if (scalar === "number") {
          allowed = ["number", "integer"];
        }
        const declared = types(properties[name]).filter((t) => t !== "null");
        assert(
          declared.length > 0 && declared.every((t) => allowed.includes(t)),
          `${key} ${name}: ${declared} is not ${scalar}`,
        );
      }
      let requiredNames: readonly string[] = [];
      if (route.required !== undefined && route.required !== null) {
        requiredNames = route.required;
      }
      for (const name of requiredNames) {
        assert(required.has(name), `${key} requires ${name}`);
      }
    }
  },
);

// The Rule schema's table says which ops each field takes; normalize_subscription_rules is the
// validator, so this only keeps the table and the enums agreeing with each other.
Deno.test("the Rule table names only declared fields and ops", function (): void {
  const schemas = resolve((spec.components as Node).schemas);
  const schema = resolve(schemas.Rule);
  const properties = schema.properties as Node;
  const fields = (properties.field as Node).enum as string[];
  const ops = (properties.op as Node).enum as string[];
  const table = new Map<string, string[]>();
  for (const line of String(schema.description).split("\n")) {
    const row = /^\| `(\w+)` \| ([^|]+) \|/.exec(line);
    // The header row names the columns.
    if (row === null || row[1] === "field") {
      continue;
    }
    const field = row[1]!;
    const rowOps = Array.from(row[2]!.matchAll(/`(\w+)`/g), (m) => m[1]!);
    let known = table.get(field);
    if (known === undefined) {
      known = [];
    }
    table.set(field, known.concat(rowOps));
  }
  assertEquals(Array.from(table.keys()).sort(), fields.slice().sort());
  for (const entry of table) {
    for (const op of entry[1]) {
      assert(ops.includes(op), `${entry[0]} ${op} is not in the op enum`);
    }
  }
  // Exact references next to the substring test (decision 14 of the reference profiles spec).
  assertEquals(table.get("reference"), ["is", "is_not", "contains", "not_contains"]);
});
