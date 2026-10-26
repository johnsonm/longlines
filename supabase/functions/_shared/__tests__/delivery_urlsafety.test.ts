import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertSafeDestinationUrl,
  assertSafePushEndpoint,
  assertSafeResolvedHost,
  defaultResolver,
  hostOf,
  isDeniedHostname,
  isPrivateIp,
  UnsafeUrlError,
} from "../delivery/urlsafety.ts";

Deno.test(
  "isPrivateIp covers loopback, private, link-local, CGNAT, unspecified and IPv6 equivalents",
  function (): void {
    for (
      const ip of [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "::",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "::ffff:10.0.0.1",
        "::ffff:127.0.0.1",
      ]
    ) {
      assertEquals(isPrivateIp(ip), true, ip);
    }
    for (
      const ip of [
        "93.184.216.34",
        "8.8.8.8",
        "172.32.0.1",
        "2606:4700::1111",
        "::ffff:93.184.216.34",
      ]
    ) {
      assertEquals(isPrivateIp(ip), false, ip);
    }
  },
);

Deno.test(
  "isPrivateIp judges IPv4 embedded in IPv6 and refuses special ranges (same as SQL)",
  function (): void {
    for (
      const ip of [
        "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
        "64:ff9b::10.0.0.1",
        "64:ff9b:1::1", // local-use NAT64
        "64:ff9b:1:abcd::808:808",
        "::7f00:1", // IPv4-compatible 127.0.0.1
        "::10.0.0.1",
        "2002:7f00:1::", // 6to4 of 127.0.0.1
        "2002:a00:1::1",
        "fec0::1", // site-local
        "ff02::1", // multicast
        "100::1", // discard
        "192.0.0.8",
        "198.18.0.1",
        "198.19.255.255",
        "224.0.0.1",
        "239.255.255.250",
        "240.0.0.1",
        "255.255.255.255",
      ]
    ) {
      assertEquals(isPrivateIp(ip), true, ip);
    }
    for (
      const ip of [
        "64:ff9b::808:808", // NAT64 of 8.8.8.8
        "::8.8.8.8",
        "2002:808:808::1",
        "192.0.2.1",
        "198.20.0.1",
        "223.255.255.255",
        "100:0:0:1::1",
        "2001:db8::1",
      ]
    ) {
      assertEquals(isPrivateIp(ip), false, ip);
    }
  },
);

Deno.test("assertSafeDestinationUrl refuses the forms SQL refuses", function (): void {
  for (
    const url of [
      "https://2130706433/x",
      "https://127.1/",
      "https://0x7f000001/",
      "https://017700000001/",
      "https://user@10.0.0.1/",
      "https://user@example.com/",
      "https://user:pw@example.com/",
      "https://[64:ff9b::a00:1]/",
      "https://224.0.0.1/",
      "https://[::ffff:7f00:1]/",
    ]
  ) {
    assertThrows(
      () => assertSafeDestinationUrl("webhook", url),
      UnsafeUrlError,
      "not allowed",
      url,
    );
  }
  assertEquals(
    assertSafeDestinationUrl("webhook", "https://8.8.8.8/x").href,
    "https://8.8.8.8/x",
  );
});

Deno.test("assertSafeDestinationUrl applies the same rules as the database", function (): void {
  assertSafeDestinationUrl("discord", "https://discord.com/api/webhooks/1/abc");
  assertSafeDestinationUrl("discord", "https://discordapp.com/api/webhooks/1/abc");
  assertSafeDestinationUrl("webhook", "https://shack.example.com:8443/spots?x=1");
  assertThrows(() => assertSafeDestinationUrl("discord", "http://discord.com/api/webhooks/1/abc"));
  assertThrows(() => assertSafeDestinationUrl("discord", "https://evil.com/api/webhooks/1/abc"));
  assertThrows(() => assertSafeDestinationUrl("discord", "https://discord.com/api/other/1/abc"));
  assertThrows(() => assertSafeDestinationUrl("webhook", "https://localhost/x"));
  assertThrows(() => assertSafeDestinationUrl("webhook", "https://foo.localhost/x"));
  assertThrows(() => assertSafeDestinationUrl("webhook", "https://10.0.0.1/x"));
  assertThrows(() => assertSafeDestinationUrl("webhook", "https://[::1]/x"));
  assertThrows(() => assertSafeDestinationUrl("webhook", "ftp://example.com/x"));
  assertThrows(() => assertSafeDestinationUrl("webhook", "not a url"), UnsafeUrlError, "https");
});

Deno.test("isPrivateIp pins Fly's 6PN and the cloud metadata address", function (): void {
  // fdaa::/16 is Fly's private network; it sits inside fc00::/7.
  assertEquals(isPrivateIp("fdaa::1"), true);
  assertEquals(isPrivateIp("fdaa:0:1::3"), true);
  assertEquals(isPrivateIp("fdaa::3"), true);
  assertEquals(isPrivateIp("169.254.169.254"), true);
});

Deno.test(
  "assertSafeDestinationUrl refuses private-only name suffixes (same list as SQL)",
  function (): void {
    for (
      const url of [
        "https://api.internal/spots",
        "https://longlines-relay.internal/spots",
        "https://api.flycast/spots",
        "https://printer.local/spots",
        "https://box.localdomain/spots",
        "https://nas.home.arpa/spots",
        "https://1.0.0.10.in-addr.arpa/spots",
        "https://API.INTERNAL/spots",
        "https://api.internal./spots",
        "https://svc.internal../spots",
        "https://localhost../spots",
        "https://api.internal:8443/spots",
      ]
    ) {
      assertThrows(
        () => assertSafeDestinationUrl("webhook", url),
        UnsafeUrlError,
        "not allowed",
        url,
      );
    }
    // Only the suffix is denied; the words may appear elsewhere in a name.
    for (
      const url of [
        "https://internal.example.com/spots",
        "https://flycast.example.com/spots",
        "https://local.example.com/spots",
        "https://arpa.example.com/spots",
        "https://api.internal.example.com/spots",
        "https://notinternal.example.com/spots",
      ]
    ) {
      assertEquals(assertSafeDestinationUrl("webhook", url).href, url);
    }
  },
);

Deno.test("isDeniedHostname covers localhost and every denied suffix", function (): void {
  for (
    const host of [
      "localhost",
      "a.localhost",
      "a.internal",
      "a.flycast",
      "a.local",
      "a.localdomain",
      "a.home.arpa",
      "a.arpa",
    ]
  ) {
    assertEquals(isDeniedHostname(host), true, host);
  }
  for (
    const host of ["example.com", "internal", "localhost.example.com", "a.internal.example.com"]
  ) {
    assertEquals(isDeniedHostname(host), false, host);
  }
});

Deno.test(
  "assertSafeResolvedHost refuses hosts that resolve to private addresses (DNS rebinding)",
  async function (): Promise<void> {
    function resolver(answers: string[]) {
      return () => Promise.resolve(answers);
    }
    assertEquals(
      await assertSafeResolvedHost(
        "shack.example.com",
        resolver(["93.184.216.34", "2606:2800::1"]),
      ),
      ["93.184.216.34", "2606:2800::1"],
    );
    await assertRejects(() =>
      assertSafeResolvedHost("evil.example.com", resolver(["93.184.216.34", "10.0.0.1"]))
    );
    await assertRejects(() =>
      assertSafeResolvedHost("evil.example.com", resolver(["::ffff:192.168.1.1"]))
    );
    await assertRejects(() => assertSafeResolvedHost("evil.example.com", resolver(["fd00::1"])));
    await assertRejects(
      () => assertSafeResolvedHost("nowhere.example.com", resolver([])),
      UnsafeUrlError,
      "nowhere.example.com did not resolve",
    );
  },
);

Deno.test(
  "assertSafeResolvedHost fails closed when the runtime cannot resolve DNS",
  async function (): Promise<void> {
    await assertRejects(
      () => assertSafeResolvedHost("shack.example.com", () => Promise.resolve(null)),
      UnsafeUrlError,
      "DNS",
    );
  },
);

Deno.test(
  "assertSafeResolvedHost skips resolution for IP literals already checked",
  async function (): Promise<void> {
    let called = false;
    function resolve(): Promise<string[]> {
      called = true;
      return Promise.resolve([]);
    }
    const addresses = await assertSafeResolvedHost("93.184.216.34", resolve);
    assertEquals(addresses, ["93.184.216.34"]);
    assertEquals(called, false);
  },
);

Deno.test("assertSafePushEndpoint accepts the browser push services", function (): void {
  for (
    const url of [
      "https://fcm.googleapis.com/fcm/send/abc:APA91b",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    ]
  ) {
    assertEquals(assertSafePushEndpoint(url).href, url);
  }
});

Deno.test("assertSafePushEndpoint refuses anything else", function (): void {
  for (
    const url of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://evilpush.apple.com/x",
      "https://push.apple.com/x",
      "https://notify.windows.com/x",
      "https://fcm.googleapis.com.evil.com/x",
      "https://evil.com/fcm.googleapis.com",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pw@fcm.googleapis.com/fcm/send/abc",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "not a url",
    ]
  ) {
    assertThrows(
      () => assertSafePushEndpoint(url),
      UnsafeUrlError,
      "Use a browser push service.",
      url,
    );
  }
});

Deno.test(
  "hostOf strips every trailing dot, as validate_destination_url's rtrim does",
  function (): void {
    assertEquals(hostOf(new URL("https://SVC.internal../x")), "svc.internal");
    assertEquals(hostOf(new URL("https://localhost.../x")), "localhost");
    assertEquals(hostOf(new URL("https://example.com./x")), "example.com");
    assertEquals(hostOf(new URL("https://[::1]/x")), "::1");
  },
);

/** A lookup with an A record and no AAAA, as for an IPv4-only host. */
function noAaaa(_host: string, type: string): Promise<string[]> {
  if (type === "A") {
    return Promise.resolve(["93.184.216.34"]);
  }
  return Promise.reject(new Deno.errors.NotFound("no AAAA"));
}

Deno.test(
  "defaultResolver keeps one record type's failure quiet and both failures as the cause",
  async function (): Promise<void> {
    const original = Deno.resolveDns;
    // No live DNS in tests: the runtime's lookup is replaced for the duration.
    function stub(lookup: (host: string, type: string) => Promise<string[]>): void {
      Object.defineProperty(Deno, "resolveDns", {
        value: lookup,
        configurable: true,
        writable: true,
      });
    }
    try {
      stub(noAaaa);
      assertEquals(await defaultResolver("v4.example.com"), ["93.184.216.34"]);

      stub(() => Promise.reject(new Deno.errors.NotFound("NXDOMAIN")));
      const error = await assertRejects(
        () => defaultResolver("nowhere.example.com"),
        UnsafeUrlError,
        "nowhere.example.com did not resolve",
      );
      if (!(error.cause instanceof AggregateError)) {
        throw new Error("expected an AggregateError cause");
      }
      assertEquals(error.cause.errors.length, 2);
    } finally {
      Object.defineProperty(Deno, "resolveDns", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  },
);
