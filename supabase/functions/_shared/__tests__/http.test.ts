import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { FunctionCallError } from "../errors.ts";
import { fetchJson, fetchText, userAgent } from "../http.ts";

/** Serve one handler on an ephemeral port, run fn against its URL, then shut down. */
async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen() {} },
    handler,
  );
  try {
    await fn(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    ac.abort();
    await server.finished;
  }
}

Deno.test("userAgent identifies Long Lines with the configured project URL", function (): void {
  assertMatch(userAgent(), /^LongLines\/0\.1 \(\+https?:\/\/\S+\)$/);
});

Deno.test(
  "fetchJson sends the User-Agent header and parses the body",
  async function (): Promise<void> {
    let seenAgent: string | null = null;
    await withServer(
      function (req) {
        seenAgent = req.headers.get("user-agent");
        return Response.json([{ ok: true }]);
      },
      async function (base) {
        assertEquals(await fetchJson(`${base}/spots`, {}), [{ ok: true }]);
        assertEquals(seenAgent, userAgent());
      },
    );
  },
);

Deno.test("fetchText returns the trimmed body", async function (): Promise<void> {
  await withServer(
    () => new Response("  7d7221c8-f4d9-4955-a976-ece92b4735b8\n"),
    async function (base) {
      assertEquals(await fetchText(`${base}/epoch`, {}), "7d7221c8-f4d9-4955-a976-ece92b4735b8");
    },
  );
});

Deno.test(
  "fetchJson throws with the status code on a non-2xx response",
  async function (): Promise<void> {
    await withServer(
      () => new Response("nope", { status: 503 }),
      async function (base) {
        const error = await assertRejects(
          () => fetchJson(`${base}/spots`, {}),
          FunctionCallError,
          "HTTP 503",
        );
        assertEquals(error.status, 503);
      },
    );
  },
);

Deno.test("fetchText aborts when the server exceeds the timeout", async function (): Promise<void> {
  await withServer(
    async function (req) {
      await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve()));
      return new Response("late");
    },
    async function (base) {
      await assertRejects(() => fetchText(`${base}/slow`, { timeoutMs: 50 }));
    },
  );
});
