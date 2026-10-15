# Webhook destinations

Long Lines delivers matching spots to a webhook destination with an HTTPS `POST`. Each request
carries up to 50 spots and is signed with the destination's signing secret, which is shown once when
the destination is created (and again when rotated).

## Request

```
POST <your url>
Content-Type: application/json
User-Agent: LongLines/0.2
X-LongLines-Timestamp: 1759676400
X-LongLines-Signature: sha256=3f1c…
```

```json
{
  "deliveries": [
    {
      "delivery_id": 1234,
      "subscription_id": "7d7221c8-f4d9-4955-a976-ece92b4735b8",
      "spot": {
        "id": 58161241,
        "source": "pota",
        "spot_time": "2026-10-05T13:37:03+00:00",
        "callsign": "DL/HB9JNH",
        "base_callsign": "HB9JNH",
        "spotter": "OK1HRA",
        "frequency_khz": 10123.9,
        "band": "30m",
        "mode": "cw",
        "mode_family": "cw",
        "comment": "RBN 22 dB 19 WPM via OK1HRA-#",
        "pota_reference": "DE-0858",
        "pota_park_name": "Via Sancti Martini National Historic Trail",
        "pota_location": "DE-BW,DE-BY,DE-RP,DE-SL",
        "sota_summit_ref": null
      }
    }
  ]
}
```

`spot` has the fields of the `recent_spots` view plus `base_callsign`, the call without prefixes or
suffixes that Long Lines profiles are keyed on. New fields may be added to `spot`, so ignore ones
you don't know. `delivery_id` is unique per spot and destination, so you can use it to deduplicate
retries.

Respond with any `2xx` status within 10 seconds. Redirects are never followed, so a `3xx` counts as
a failure; point the destination at the final URL. Anything else, including a timeout, is a failure:
the batch is retried with backoff (30 s, 1 m, 2 m, 5 m, 15 m, then every 30 m) for up to 24 hours,
after which it is dropped. Five consecutive failures mark the destination "Failing" in the app; the
next success clears it.

A "Send test" from the app delivers one sample spot whose callsign is `N0CALL` and whose comment
says it is a test; `delivery_id` and `subscription_id` are zero-valued.

## Verifying the signature

The signature is an HMAC-SHA256, hex encoded, over the string `"{timestamp}.{raw body}"` using your
signing secret as the key. Compute it from the exact bytes you received, before parsing the JSON,
and compare in constant time. Reject timestamps more than a few minutes old to limit replay.

```ts
// Node 18+ / Deno / Bun
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyLongLines(
  secret: string,
  headers: Headers,
  rawBody: string,
  maxSkewSeconds = 300,
): boolean {
  const timestamp = headers.get("x-longlines-timestamp") ?? "";
  const signature = headers.get("x-longlines-signature") ?? "";
  if (!/^\d+$/.test(timestamp) || !signature.startsWith("sha256=")) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > maxSkewSeconds) return false;

  const expected = "sha256=" +
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Express example:

```ts
app.post("/spots", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  if (
    !verifyLongLines(
      process.env.LONGLINES_SECRET!,
      new Headers(req.headers as Record<string, string>),
      raw,
    )
  ) {
    return res.status(401).end();
  }
  const { deliveries } = JSON.parse(raw);
  // ... handle spots ...
  res.status(204).end();
});
```

## Rotating the secret

Rotate from the Destinations page. The new secret takes effect for the next delivery; update your
receiver first if you cannot tolerate a brief window of rejected requests.

## Address rules

Webhook URLs must use `https`, and the hostname may not be `localhost` or an IP address in a
private, loopback, link-local, CGNAT or unspecified range. The delivery worker also resolves the
hostname before each request and refuses hosts that resolve to such addresses.
