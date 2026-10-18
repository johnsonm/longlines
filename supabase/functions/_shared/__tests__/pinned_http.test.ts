import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { MAX_RESPONSE_HEAD_BYTES, pinnedPost } from "../delivery/pinned_http.ts";

// fixtures/tls: a test CA (ca.pem, its key discarded) that signed P-256 leaf
// certificates for "localhost" and "other.test", valid until 2126. Made with
// openssl req -x509 / openssl x509 -req; SAN DNS:<name>, serverAuth.
const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url));
const CA = fixture("ca.pem");
const LOCALHOST = { cert: fixture("localhost.pem"), key: fixture("localhost.key") };
const OTHER = { cert: fixture("other.test.pem"), key: fixture("other.test.key") };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Received {
  head: string;
  body: string;
}

/** Reads one request: the head, then Content-Length bytes of body. */
async function readRequest(conn: Deno.Conn): Promise<Received> {
  let buf = new Uint8Array(0);
  const chunk = new Uint8Array(4096);
  for (;;) {
    const text = decoder.decode(buf);
    const end = text.indexOf("\r\n\r\n");
    if (end >= 0) {
      const length = Number(/\r\ncontent-length: (\d+)/i.exec(text)?.[1] ?? "0");
      if (buf.length >= end + 4 + length) {
        return { head: text.slice(0, end), body: text.slice(end + 4, end + 4 + length) };
      }
    }
    const n = await conn.read(chunk);
    if (n === null) return { head: text, body: "" };
    const next = new Uint8Array(buf.length + n);
    next.set(buf);
    next.set(chunk.subarray(0, n), buf.length);
    buf = next;
  }
}

/** Waits until the client closes its end (or errors), so tests prove the client stops on its own. */
async function untilClosed(conn: Deno.Conn): Promise<void> {
  const chunk = new Uint8Array(1024);
  try {
    while ((await conn.read(chunk)) !== null) {
      // discard
    }
  } catch {
    // reset by the client
  }
}

type Handler = (conn: Deno.Conn, request: Received) => Promise<void>;

/** One-connection server; `fn` gets its port. Plain TCP when `tls` is null. */
async function withServer(
  tls: { cert: string; key: string } | null,
  handler: Handler,
  fn: (port: number) => Promise<void>,
): Promise<Received | null> {
  const listener = tls
    ? Deno.listenTls({ hostname: "127.0.0.1", port: 0, ...tls })
    : Deno.listen({ hostname: "127.0.0.1", port: 0 });
  let received: Received | null = null;
  const served = (async () => {
    let conn: Deno.Conn;
    try {
      conn = await listener.accept();
    } catch {
      return; // listener closed without a connection
    }
    try {
      received = await readRequest(conn);
      await handler(conn, received);
    } catch {
      // the client went away; the test's assertions say whether that was expected
    } finally {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  })();
  try {
    await fn((listener.addr as Deno.NetAddr).port);
  } finally {
    listener.close();
    await served;
  }
  return received;
}

const reply = (text: string): Handler => async (conn) => {
  await conn.write(encoder.encode(text));
  await untilClosed(conn);
};

const init = { headers: { "Content-Type": "application/json" }, body: "{}", timeoutMs: 5000 };

Deno.test("pinnedPost connects to the address but verifies TLS against the hostname", async () => {
  let port = 0;
  const received = await withServer(
    LOCALHOST,
    reply("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Test: yes\r\n\r\nok"),
    async (p) => {
      port = p;
      const response = await pinnedPost(
        new URL(`https://localhost:${port}/hook/path?a=1&b=2`),
        "127.0.0.1",
        {
          headers: { "Content-Type": "application/json", "X-LongLines-Signature": "v1=abc" },
          body: '{"spot":1}',
          timeoutMs: 5000,
          caCerts: [CA],
        },
      );
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("x-test"), "yes");
    },
  );
  assert(received);
  const lines = received.head.split("\r\n");
  assertEquals(lines[0], "POST /hook/path?a=1&b=2 HTTP/1.1");
  assertEquals(lines[1], `Host: localhost:${port}`);
  assert(lines.includes("Content-Type: application/json"));
  assert(lines.includes("X-LongLines-Signature: v1=abc"));
  assert(lines.includes("Content-Length: 10"));
  assert(lines.includes("Connection: close"));
  assertEquals(received.body, '{"spot":1}');
});

Deno.test("pinnedPost refuses a certificate issued for another name", async () => {
  await withServer(OTHER, reply("HTTP/1.1 200 OK\r\n\r\n"), async (port) => {
    await assertRejects(
      () =>
        pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", { ...init, caCerts: [CA] }),
      Error,
      'certificate not valid for name "localhost"',
    );
  });
});

Deno.test("pinnedPost refuses a certificate from an untrusted issuer", async () => {
  await withServer(LOCALHOST, reply("HTTP/1.1 200 OK\r\n\r\n"), async (port) => {
    await assertRejects(
      () => pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", init),
      Error,
      "UnknownIssuer",
    );
  });
});

Deno.test("pinnedPost reports a 429 and its Retry-After", async () => {
  await withServer(
    LOCALHOST,
    reply("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 17\r\nContent-Length: 0\r\n\r\n"),
    async (port) => {
      const response = await pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", {
        ...init,
        caCerts: [CA],
      });
      assertEquals(response.status, 429);
      assertEquals(response.headers.get("retry-after"), "17");
    },
  );
});

Deno.test("pinnedPost returns a redirect as a status and does not follow it", async () => {
  await withServer(
    LOCALHOST,
    reply("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/\r\nContent-Length: 0\r\n\r\n"),
    async (port) => {
      const response = await pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", {
        ...init,
        caCerts: [CA],
      });
      assertEquals(response.status, 302);
      assertEquals(response.headers.get("location"), "http://127.0.0.1/");
    },
  );
});

Deno.test("pinnedPost stops at the end of a chunked body without waiting for close", async () => {
  await withServer(
    LOCALHOST,
    reply(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
        "5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: t\r\n\r\n",
    ),
    async (port) => {
      const started = Date.now();
      const response = await pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", {
        ...init,
        timeoutMs: 3000,
        caCerts: [CA],
      });
      assertEquals(response.status, 200);
      assert(Date.now() - started < 2000);
    },
  );
});

Deno.test("pinnedPost stops after Content-Length bytes without waiting for close", async () => {
  await withServer(
    null,
    reply("HTTP/1.1 201 Created\r\nContent-Length: 5\r\n\r\nhello"),
    async (port) => {
      const response = await pinnedPost(new URL(`http://localhost:${port}/`), "127.0.0.1", {
        ...init,
        timeoutMs: 3000,
        allowInsecure: true,
      });
      assertEquals(response.status, 201);
    },
  );
});

Deno.test("pinnedPost reads a body without framing until close, capped", async () => {
  await withServer(
    null,
    async (conn) => {
      await conn.write(encoder.encode("HTTP/1.0 200 OK\r\n\r\n"));
      // More than the cap: the client must stop reading and close.
      const block = new Uint8Array(16 * 1024);
      try {
        for (let i = 0; i < 64; i++) await conn.write(block);
      } catch {
        // the client closed after the cap
      }
    },
    async (port) => {
      const response = await pinnedPost(new URL(`http://localhost:${port}/`), "127.0.0.1", {
        ...init,
        allowInsecure: true,
      });
      assertEquals(response.status, 200);
    },
  );
});

Deno.test("pinnedPost skips 1xx interim responses", async () => {
  await withServer(
    LOCALHOST,
    reply("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\nX-Final: 1\r\n\r\n"),
    async (port) => {
      const response = await pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", {
        ...init,
        caCerts: [CA],
      });
      assertEquals(response.status, 204);
      assertEquals(response.headers.get("x-final"), "1");
    },
  );
});

Deno.test("pinnedPost rejects oversized response headers", async () => {
  await withServer(
    LOCALHOST,
    reply(`HTTP/1.1 200 OK\r\nX-Big: ${"a".repeat(MAX_RESPONSE_HEAD_BYTES)}\r\n\r\n`),
    async (port) => {
      await assertRejects(
        () =>
          pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", {
            ...init,
            caCerts: [CA],
          }),
        Error,
        "response headers exceed",
      );
    },
  );
});

Deno.test("pinnedPost keeps a 2xx whose headers are non-ASCII or have no colon", async () => {
  const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
  const heads: [string, Uint8Array][] = [
    // UTF-8 "café → ok": bytes above 0x7f, one character above U+00FF once decoded as UTF-8.
    ["a UTF-8 value", encoder.encode("HTTP/1.1 200 OK\r\nX-Note: café → ok\r\nRetry-After: 3\r\n")],
    ["a raw 0xE9 byte", latin1("HTTP/1.1 200 OK\r\nX-Note: caf\xe9\r\nRetry-After: 3\r\n")],
    [
      "a line without a colon",
      encoder.encode("HTTP/1.1 200 OK\r\nNo colon here\r\nRetry-After: 3\r\n"),
    ],
    ["a bad header name", encoder.encode("HTTP/1.1 200 OK\r\nBad Name: x\r\nRetry-After: 3\r\n")],
  ];
  for (const [label, head] of heads) {
    await withServer(
      null,
      async (conn) => {
        await conn.write(head);
        await conn.write(encoder.encode("Content-Length: 2\r\n\r\nok"));
        await untilClosed(conn);
      },
      async (port) => {
        const response = await pinnedPost(new URL(`http://localhost:${port}/`), "127.0.0.1", {
          ...init,
          allowInsecure: true,
        });
        assertEquals(response.status, 200, label);
        assertEquals(response.headers.get("retry-after"), "3", label);
      },
    );
  }
  // The raw byte reaches the header as U+00E9, byte for byte.
  await withServer(
    null,
    async (conn) => {
      await conn.write(latin1("HTTP/1.1 204 No Content\r\nX-Note: caf\xe9 \x80\r\n\r\n"));
      await untilClosed(conn);
    },
    async (port) => {
      const response = await pinnedPost(new URL(`http://localhost:${port}/`), "127.0.0.1", {
        ...init,
        allowInsecure: true,
      });
      assertEquals(response.headers.get("x-note"), "caf\u00e9 \u0080");
    },
  );
});

Deno.test("pinnedPost rejects malformed responses", async () => {
  for (
    const [text, message] of [
      ["SMTP ready\r\n\r\n", "malformed HTTP status line"],
      ["HTTP/1.1 200 OK\r\nX-A: 1\r\n folded\r\n\r\n", "folded HTTP response header"],
      ["HTTP/1.1 101 Switching Protocols\r\n\r\n", "unexpected HTTP 101"],
      ["HTTP/1.1 200 OK\r\n", "connection closed before the response"],
    ]
  ) {
    await withServer(
      null,
      async (conn) => {
        await conn.write(encoder.encode(text!));
      },
      async (port) => {
        await assertRejects(
          () =>
            pinnedPost(new URL(`http://localhost:${port}/`), "127.0.0.1", {
              ...init,
              allowInsecure: true,
            }),
          Error,
          message,
        );
      },
    );
  }
});

Deno.test("pinnedPost times out on a server that never answers", async () => {
  await withServer(LOCALHOST, (conn) => untilClosed(conn), async (port) => {
    const started = Date.now();
    await assertRejects(
      () =>
        pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", {
          ...init,
          timeoutMs: 200,
          caCerts: [CA],
        }),
      Error,
      "timed out after 200 ms",
    );
    assert(Date.now() - started < 2000);
  });
});

Deno.test("pinnedPost stops when the caller's signal aborts", async () => {
  await withServer(LOCALHOST, (conn) => untilClosed(conn), async (port) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assertRejects(
      () =>
        pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", {
          ...init,
          signal: ac.signal,
          caCerts: [CA],
        }),
      Error,
      "aborted",
    );
  });
  const aborted = new AbortController();
  aborted.abort();
  await assertRejects(
    () =>
      pinnedPost(new URL("https://localhost:1/"), "127.0.0.1", { ...init, signal: aborted.signal }),
    Error,
    "aborted",
  );
});

Deno.test("pinnedPost refuses header injection before connecting", async () => {
  const url = new URL("https://localhost:1/");
  for (
    const [headers, message] of [
      [{ "X-A": "1\r\nX-Injected: 2" }, "invalid value for request header X-A"],
      [{ "X-A": "1\nX-Injected: 2" }, "invalid value for request header X-A"],
      [{ "X-A\r\nX-B": "1" }, "invalid request header name"],
      [{ "Bad Name": "1" }, "invalid request header name"],
      [{ "host": "evil.test" }, "request header host is set by the client"],
      [{ "Content-Length": "1" }, "request header Content-Length is set by the client"],
    ] as const
  ) {
    await assertRejects(
      () => pinnedPost(url, "127.0.0.1", { ...init, headers }),
      Error,
      message,
    );
  }
});

Deno.test("pinnedPost refuses http without allowInsecure, and URL credentials", async () => {
  await assertRejects(
    () => pinnedPost(new URL("http://localhost:1/"), "127.0.0.1", init),
    Error,
    "Use an https URL.",
  );
  await assertRejects(
    () => pinnedPost(new URL("https://u:p@localhost:1/"), "127.0.0.1", init),
    Error,
    "URL has credentials",
  );
});

Deno.test("pinnedPost reports a refused connection", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const error = await assertRejects(() =>
    pinnedPost(new URL(`https://localhost:${port}/`), "127.0.0.1", init)
  );
  assertMatch(String(error), /refused|connect/i);
});

Deno.test("pinnedPost accepts a Uint8Array body", async () => {
  const received = await withServer(
    null,
    reply("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n"),
    async (port) => {
      const response = await pinnedPost(new URL(`http://localhost:${port}`), "127.0.0.1", {
        headers: {},
        body: new Uint8Array([1, 2, 3]),
        timeoutMs: 5000,
        allowInsecure: true,
      });
      assertEquals(response.status, 202);
    },
  );
  assert(received);
  assert(received.head.startsWith("POST / HTTP/1.1\r\n"));
  assert(received.head.includes("Content-Length: 3"));
});
