// Minimal stand-in for the slice of SupabaseClient the handlers and db.ts use:
// rpc, from(...).select/eq/single/maybeSingle/insert (or awaiting the builder),
// and a few auth calls.
// Every call is recorded so tests can assert what was sent.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface FakeError {
  message: string;
  code?: string;
  /** HTTP status, as on an AuthError. */
  status?: number;
}

export interface FakeResult {
  data?: unknown;
  error?: FakeError | null;
}

type Responder = FakeResult | ((args: Record<string, unknown> | undefined) => FakeResult);

export interface FakeSupabaseOptions {
  rpc?: Record<string, Responder>;
  /** Result of the terminal call (single, maybeSingle, insert) on each table. */
  from?: Record<string, FakeResult>;
  getUser?: FakeResult;
  deleteUser?: FakeResult;
  signInWithPassword?: FakeResult;
}

export interface FakeCalls {
  rpc: Array<{ fn: string; args: Record<string, unknown> | undefined }>;
  from: Array<{ table: string; ops: Array<[string, unknown[]]> }>;
  getUser: string[];
  deleteUser: string[];
  signInWithPassword: Array<{ email: string; password: string }>;
}

function settle(
  result: FakeResult | undefined,
): Promise<{ data: unknown; error: FakeError | null }> {
  let data: unknown = null;
  let error: FakeError | null = null;
  if (result !== null && result !== undefined) {
    if (result.data !== null && result.data !== undefined) {
      data = result.data;
    }
    if (result.error !== null && result.error !== undefined) {
      error = result.error;
    }
  }
  return Promise.resolve({ data, error });
}

export function fakeSupabase(
  options: FakeSupabaseOptions,
): { client: SupabaseClient; calls: FakeCalls } {
  const calls: FakeCalls = {
    rpc: [],
    from: [],
    getUser: [],
    deleteUser: [],
    signInWithPassword: [],
  };

  const fake = {
    rpc(fn: string, args: Record<string, unknown> | undefined) {
      calls.rpc.push({ fn, args });
      let responder: Responder | undefined = undefined;
      if (options.rpc !== null && options.rpc !== undefined) {
        responder = options.rpc[fn];
      }
      if (typeof responder === "function") {
        return settle(responder(args));
      }
      return settle(responder);
    },
    from(table: string) {
      const entry = { table, ops: [] as Array<[string, unknown[]]> };
      calls.from.push(entry);
      let result: FakeResult | undefined = undefined;
      if (options.from !== null && options.from !== undefined) {
        result = options.from[table];
      }
      const builder = {
        select(...a: unknown[]) {
          entry.ops.push(["select", a]);
          return builder;
        },
        eq(...a: unknown[]) {
          entry.ops.push(["eq", a]);
          return builder;
        },
        single() {
          entry.ops.push(["single", []]);
          return settle(result);
        },
        maybeSingle() {
          entry.ops.push(["maybeSingle", []]);
          return settle(result);
        },
        insert(...a: unknown[]) {
          entry.ops.push(["insert", a]);
          return settle(result);
        },
        // Awaiting the builder itself (a plain select of many rows).
        async then<T>(onFulfilled: (value: { data: unknown; error: FakeError | null }) => T) {
          return onFulfilled(await settle(result));
        },
      };
      return builder;
    },
    auth: {
      getUser(token: string) {
        calls.getUser.push(token);
        return settle(options.getUser);
      },
      signInWithPassword(credentials: { email: string; password: string }) {
        calls.signInWithPassword.push(credentials);
        return settle(options.signInWithPassword);
      },
      admin: {
        deleteUser(id: string) {
          calls.deleteUser.push(id);
          return settle(options.deleteUser);
        },
      },
    },
  };

  // The fake implements only the methods the code under test calls; the cast
  // is what lets it stand in for the full generated client type.
  return { client: fake as unknown as SupabaseClient, calls };
}
