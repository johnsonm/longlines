import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertSafeDestinationUrl,
  assertSafePushEndpoint,
  assertSafeResolvedHost,
  isPrivateIp,
} from "../delivery/urlsafety.ts";

Deno.test("isPrivateIp covers loopback, private, link-local, CGNAT, unspecified and IPv6 equivalents", () => {
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
});

Deno.test("assertSafeDestinationUrl applies the same rules as the database", () => {
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
  assertThrows(() => assertSafeDestinationUrl("webhook", "not a url"));
});

Deno.test("assertSafeResolvedHost refuses hosts that resolve to private addresses (DNS rebinding)", async () => {
  const resolver = (answers: string[]) => (_host: string) => Promise.resolve(answers);
  await assertSafeResolvedHost("shack.example.com", resolver(["93.184.216.34"]));
  await assertRejects(() =>
    assertSafeResolvedHost("evil.example.com", resolver(["93.184.216.34", "10.0.0.1"]))
  );
  await assertRejects(() =>
    assertSafeResolvedHost("evil.example.com", resolver(["::ffff:192.168.1.1"]))
  );
  await assertRejects(() => assertSafeResolvedHost("evil.example.com", resolver(["fd00::1"])));
  await assertRejects(() => assertSafeResolvedHost("nowhere.example.com", resolver([])));
});

Deno.test("assertSafeResolvedHost fails closed when the runtime cannot resolve DNS", async () => {
  await assertRejects(
    () => assertSafeResolvedHost("shack.example.com", () => Promise.resolve(null)),
    Error,
    "DNS",
  );
});

Deno.test("assertSafeResolvedHost skips resolution for IP literals already checked", async () => {
  let called = false;
  await assertSafeResolvedHost("93.184.216.34", () => {
    called = true;
    return Promise.resolve([]);
  });
  assertEquals(called, false);
});

Deno.test("assertSafePushEndpoint accepts the browser push services", () => {
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

Deno.test("assertSafePushEndpoint refuses anything else", () => {
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
    assertThrows(() => assertSafePushEndpoint(url), Error, "Use a browser push service.", url);
  }
});
