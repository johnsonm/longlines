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
    current = current.$ref.replace(/^#\//, "").split("/")
      .reduce<unknown>((at, key) => (at as Node)[key], spec) as Node;
  }
  return current;
}

/** A schema's properties and required keys, merged across allOf and oneOf. */
function flatten(node: unknown): { properties: Node; required: Set<string> } {
  const schema = resolve(node);
  const properties: Node = { ...(schema.properties as Node | undefined) };
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const oneOf = (schema.oneOf as unknown[] | undefined) ?? [];
  for (const part of [...((schema.allOf as unknown[] | undefined) ?? []), ...oneOf]) {
    const inner = flatten(part);
    Object.assign(properties, inner.properties);
    for (const key of inner.required) required.add(key);
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
  if ("const" in schema) return [typeof schema.const];
  const type = schema.type;
  return Array.isArray(type) ? type : typeof type === "string" ? [type] : [];
}

interface Operation {
  key: string;
  op: Node;
}

function operations(): Operation[] {
  const paths = spec.paths as Record<string, Node>;
  return Object.entries(paths).flatMap(([path, item]) =>
    METHODS.filter((m) => m in item).map((m) => ({
      key: `${m.toUpperCase()} /v1${path.replaceAll("{id}", ":id")}`,
      op: item[m] as Node,
    }))
  );
}

function routeFor(key: string): Route {
  const found = ROUTES.find(([m, p]) => `${m} ${p}` === key);
  if (!found) throw new Error(`${key} is not routed`);
  return found[2];
}

Deno.test("the spec has exactly the routed operations", () => {
  assertEquals(
    operations().map((o) => o.key).sort(),
    ROUTES.map(([m, p]) => `${m} ${p}`).sort(),
  );
});

Deno.test("operation ids are the api_call ops, with connections for subscriptions", () => {
  for (const { key, op } of operations()) {
    assertEquals(op.operationId, routeFor(key).op.replace("subscription", "connection"), key);
  }
});

Deno.test("each operation needs the route's scope", () => {
  for (const { key, op } of operations()) {
    const security = (op.security ?? spec.security) as Record<string, string[]>[];
    assertEquals(security, [{ apiToken: [routeFor(key).scope] }], key);
  }
});

Deno.test("each operation's success status is the route's", () => {
  for (const { key, op } of operations()) {
    const success = Object.keys(op.responses as Node).filter((s) => s.startsWith("2"));
    assertEquals(success, [String(routeFor(key).status)], key);
  }
});

Deno.test("request bodies have the fields checkBody checks, with the same shapes", () => {
  for (const { key, op } of operations()) {
    const route = routeFor(key);
    if (route.input === "none") {
      assertEquals(op.requestBody, undefined, key);
      continue;
    }
    const body = resolve(op.requestBody);
    const content = body.content as Record<string, Node>;
    const { properties, required } = flatten(content["application/json"]?.schema);

    const arrays = route.arrays ?? [];
    const lists = route.lists ?? [];
    const scalars = Object.entries(route.scalars ?? {});
    assertEquals(
      Object.keys(properties).sort(),
      [...arrays, ...lists, ...scalars.map(([k]) => k)].sort(),
      key,
    );
    for (const name of arrays) {
      const prop = resolve(properties[name]);
      assertEquals(types(prop), ["array"], `${key} ${name}`);
      assertEquals(types(prop.items), ["string"], `${key} ${name} items`);
    }
    for (const name of lists) assertEquals(types(properties[name]), ["array"], `${key} ${name}`);
    for (const [name, scalar] of scalars) {
      const allowed = scalar === "number" ? ["number", "integer"] : [scalar];
      const declared = types(properties[name]).filter((t) => t !== "null");
      assert(
        declared.length > 0 && declared.every((t) => allowed.includes(t)),
        `${key} ${name}: ${declared} is not ${scalar}`,
      );
    }
    for (const name of route.required ?? []) assert(required.has(name), `${key} requires ${name}`);
  }
});
