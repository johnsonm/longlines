# Webhook destinations

Long Lines delivers matching spots to a webhook destination with an HTTPS `POST` and a JSON
body. Each destination picks which spot fields are sent and in what order, how keys, times and
frequencies are written, whether spots go one per request or grouped, and how failed requests are
retried. Every request is signed with the destination's signing secret, which is shown once when
the destination is added and again when it is rotated.

The body changed in October 2026; see [Changed 2026-10](#changed-2026-10) if your receiver reads
`{"deliveries": [...]}`.

## Request

```
POST /hook/abc123 HTTP/1.1
Host: logger.example.org
Accept: */*
Content-Type: application/json
User-Agent: LongLines/0.2
X-LongLines-Timestamp: 1792258930
X-LongLines-Signature: sha256=3b1f…e07a
Authorization: Bearer …
```

Headers go out in this order: `Host`, the fixed five (`Accept`, `Content-Type`, `User-Agent`,
`X-LongLines-Timestamp`, `X-LongLines-Signature`), then `X-LongLines-Test: true` on a test, then
the destination's extra headers in the order they were added.

**Extra headers.** A destination can send up to 10 extra headers with every request, for example
an API key in `Authorization`. Names use letters, digits, `-`, `_` and `.` (up to 64 characters,
starting with a letter or digit), each name once ignoring case. Values are 1 to 1,024 printable
ASCII characters. Names Long Lines sets are refused, ignoring case: `Accept`, `Connection`,
`Content-Encoding`, `Content-Length`, `Content-Type`, `Expect`, `Host`, `Keep-Alive`, `TE`,
`Trailer`, `Transfer-Encoding`, `Upgrade`, `User-Agent`, and any name starting `Proxy-` or
`X-LongLines-`, so an extra header can never replace a fixed one. Values are stored encrypted
(Supabase Vault) and never shown again after saving.

### One request per spot

With "One request per spot" each request carries one spot. With the default fields:

```json
{
  "delivery_id": 918273,
  "connection": "POTA states I still need",
  "spot": {
    "id": 4421907,
    "time": "2026-10-17T17:42:09Z",
    "callsign": "KK4PWJ",
    "frequency_khz": 14062,
    "mode": "cw",
    "band": "20m",
    "source": "pota",
    "reference": "US-2763",
    "place_name": "Falls Lake SRA",
    "state": "NC",
    "spotter": "W4ABC"
  }
}
```

- `delivery_id` (integer) is unique per spot and destination, so you can use it to recognize a
  retry.
- `connection` is the name of the connection that matched.
- `spot` holds the fields the destination picked, in the order it picked them.

### Grouped

With "Group spots every 10, 30 or 60 seconds" each request carries a `spots` list of up to 50
items, each exactly a single body. One request can hold several connections' spots. This example
uses camelCase, MHz, Unix seconds and "Send null", with Country and Spot URL added:

```json
{
  "spots": [
    {
      "delivery_id": 918274,
      "connection": "POTA states I still need",
      "spot": {
        "id": 4421910, "time": 1792258950, "callsign": "N4XYZ", "frequencyMhz": 7.0335,
        "mode": "cw", "band": "40m", "source": "pota", "reference": "US-4567",
        "placeName": "Eno River SP", "state": "NC", "spotter": "N4XYZ",
        "country": "United States", "url": "https://pota.app/#/park/US-4567"
      }
    },
    {
      "delivery_id": 918275,
      "connection": "Summits on 2m",
      "spot": {
        "id": 4421913, "time": 1792258961, "callsign": "W4/G4ABC/P", "frequencyMhz": 146.52,
        "mode": "fm", "band": "2m", "source": "sotawatch", "reference": "W4C/CM-001",
        "placeName": null, "state": null, "spotter": "KK4PWJ",
        "country": "United States", "url": "https://summits.sota.org.uk/summit/W4C/CM-001"
      }
    }
  ]
}
```

A destination's first spot after a quiet spell waits at most the window; once 50 are waiting they
go at once.

## Spot fields

Each destination picks 1 to 16 of these, in any order. Key names are fixed: you choose the style,
not the name.

| Field | snake_case key | camelCase key | Value | Type | No value when |
| --- | --- | --- | --- | --- | --- |
| Spot ID | `id` | `id` | Long Lines' spot id | integer | never |
| Time | `time` | `time` | the spot time (see below) | string or integer | never |
| Callsign | `callsign` | `callsign` | the call as spotted | string | never |
| First name | `first_name` | `firstName` | the first name on the spotted call's license (FCC records only), as the license has it | string | no license, a club, or a call hidden on request |
| Last name | `last_name` | `lastName` | the last name on the spotted call's license, as the license has it | string | no license, a club, or a call hidden on request |
| Frequency | `frequency_khz`, `frequency_mhz`, `frequency_hz` | `frequencyKhz`, `frequencyMhz`, `frequencyHz` | see below | number | never |
| Mode | `mode` | `mode` | lower case: `cw`, `ssb`, `ft8` | string | the spot has no mode |
| Band | `band` | `band` | `20m`, `2m`, `70cm` | string | outside every band |
| Source | `source` | `source` | `pota`, `sotawatch`, `wwff`, `dxcluster` or `rbn` | string | never |
| Reference | `reference` | `reference` | POTA park (`US-2763`), SOTA summit (`W4C/CM-001`) or WWFF reference (`KFF-5268`) | string | DX Cluster, RBN |
| Place name | `place_name` | `placeName` | POTA park name or WWFF reference name | string | SOTA, DX Cluster, RBN, or no name |
| State | `state` | `state` | the POTA location after the dash (`US-NC` is `NC`), several joined by `/` (`NC/VA`) | string | not POTA, or no location |
| Spotter | `spotter` | `spotter` | the spotter's call as sent | string | none given |
| Country | `country` | `country` | the cty.dat entity name of the callsign (`United States`) | string | no match |
| Spot URL | `url` | `url` | the pota.app park, the SOTA summit page or the WWFF directory entry | string | DX Cluster, RBN |
| Comment | `comment` | `comment` | the comment as the spotter typed it | string | empty |

The default fields are Spot ID, Time, Callsign, Frequency, Mode, Band, Source, Reference, Place
name, State and Spotter, in that order, with snake_case keys, ISO times, kHz and "Leave the key
out".

- **Time.** "ISO 8601, UTC" is a string in whole seconds, always ending `Z`
  (`"2026-10-17T17:42:09Z"`). "Unix seconds" is an integer (`1792258929`).
- **Frequency.** kHz as stored (`14062`, `10123.9`), MHz (`14.062`, `10.1239`) or Hz
  (`14062000`). Every conversion is exact. The unit changes the key too.
- **Values as stored.** `id` and `delivery_id` are integers; `source` and `mode` are lower-case
  ids. A callsign or spotter from DX Cluster is whatever the cluster sent.
- **Missing values.** With "Leave the key out" a field with no value is not in `spot`; with "Send
  null" its key is there with `null`. A spot can have no picked value at all (only Reference
  picked, on a DX Cluster spot), and then `"spot": {}`.
- **Comment** is text typed by whoever spotted, so treat it as untrusted. It is a JSON string,
  never markup.
- **Order.** The keys of `spot` are written in the order the destination picked them. Deliveries
  go out newest first and nothing guarantees their order: spots in one request, and consecutive
  requests, can arrive out of time order, so sort on the time yourself if it matters.
- New fields may be added to the catalog later; a destination only sends what it picked.

## Responses, retries and pausing

Respond with any `2xx` status within 10 seconds. Anything else, including a timeout, is a
failure. Redirects are never followed, so a `3xx` is a failure; point the destination at the
final URL.

**Retry policy**, chosen per destination. Only spots that were in a failed request count an
attempt: Long Lines stops at a destination's first failed request in a cycle, and the spots it
had not sent yet are tried again about a minute later without counting.

| Policy | Retries after a failed attempt | Dropped |
| --- | --- | --- |
| Don't retry | none | after the first failure |
| Up to 3 times over 10 minutes | 1, 3 and 6 minutes after each failure (about 1, 4 and 10 minutes after the first) | after the fourth failure |
| Keep trying for 24 hours | 30 s, 1 m, 2 m, 5 m, 15 m, then every 30 m | when 24 hours old |

Whatever the policy, a spot still waiting 24 hours after it matched is dropped.

**429.** A `429` delays rather than fails: the destination is held back for `Retry-After`
seconds (or, without that header, 60 s doubling to 15 minutes while the 429s continue), the same
spots are sent again afterwards, and nothing counts as a failure or an attempt.

**Health.** Five failed requests in a row mark the destination "Failing" in the app; the next
success clears it.

**Pause after repeated failures** (on by default for new destinations; webhooks added before
the editor shipped keep it off until it is turned on in the editor): after 20 failed requests in a
row the destination is turned off. Failures count toward the pause at most once every 30
seconds, so 20 take at least about 10 minutes of failing; a short outage such as a deploy does not
pause a busy destination. A success starts the count again. When it pauses, the spots waiting to
be sent are dropped and no new ones are queued. The app shows when it paused; turn Enabled back on
and save (or `PATCH /v1/destinations/{id}` with `"enabled": true`) to resume.

**Throughput.** With one request per spot a destination gets at most 5 requests every few
seconds, about 50 spots a minute; a busier connection should group. Requests to one destination go
one after another, so a receiver that answers slowly also slows its own later spots: answer
quickly and do the work afterwards. Grouped requests carry up to 50 spots each.

## Send test

"Send test request" in the editor (or `POST /v1/destinations/{id}/test`) sends one sample spot,
or the spot the preview shows, rendered with the destination's saved settings and extra headers.
The request carries `X-LongLines-Test: true`, `"connection": "Test"` and `"delivery_id": 0`, and
has the destination's shape (a grouped destination gets a one-item `spots` list). The app shows
the HTTP status your receiver answered. A test is not a delivery: it is not retried or counted.

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

  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Express example, reading both shapes:

```ts
app.post("/spots", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  if (!verifyLongLines(process.env.LONGLINES_SECRET!, new Headers(req.headers as Record<string, string>), raw)) {
    return res.status(401).end();
  }
  const body = JSON.parse(raw);
  const items = Array.isArray(body.spots) ? body.spots : [body];
  const isTest = req.get("x-longlines-test") === "true";
  for (const { delivery_id, connection, spot } of items) {
    // ... handle the spot; delivery_id repeats only on a retry ...
  }
  res.status(204).end();
});
```

## Rotating the secret

Rotate from the destination's editor. The new secret takes effect for the next request; update
your receiver first if you cannot tolerate a brief window of rejected requests.

## Address rules

Webhook URLs must use `https`, may not carry a user name or password, and the hostname may not be
`localhost` or an IP address in a private, loopback, link-local, CGNAT, unspecified, multicast or
other special-purpose range (including IPv6 forms that embed such an IPv4 address, such as NAT64
and 6to4). An IPv4 address must be written as a plain dotted quad (`203.0.113.5`, not
`3405803781` or `0xcb007105`). The delivery worker also resolves the hostname before each request
and refuses hosts that resolve to such addresses. After saving, the app shows the URL with its
last non-empty path segment hidden (`https://logger.example.org/hook/••••••`, or
`https://hooks.zapier.com/hooks/catch/123456/••••••/` when the URL ends in a slash).

## Changed 2026-10

Before October 2026 every request was a list of up to 50 spots with the stored columns:

```json
{
  "deliveries": [
    {
      "delivery_id": 1234,
      "connection_id": "7d7221c8-f4d9-4955-a976-ece92b4735b8",
      "spot": {
        "id": 58161241, "source": "pota", "spot_time": "2026-10-05T13:37:03+00:00",
        "callsign": "DL/HB9JNH", "base_callsign": "HB9JNH", "spotter": "OK1HRA",
        "frequency_khz": 10123.9, "band": "30m", "mode": "cw", "mode_family": "cw",
        "comment": "RBN 22 dB 19 WPM via OK1HRA-#", "pota_reference": "DE-0858",
        "pota_park_name": "Via Sancti Martini National Historic Trail",
        "pota_location": "DE-BW,DE-BY,DE-RP,DE-SL", "sota_summit_ref": null,
        "wwff_reference": null, "wwff_reference_name": null
      }
    }
  ]
}
```

Existing destinations were moved to the settings closest to that: every field, grouped every 10
seconds, "Keep trying for 24 hours", and no pause. To migrate a receiver:

- Read `body.spots` (grouped) or the body itself (one request per spot) instead of
  `body.deliveries`; the Express example above takes both.
- `connection_id` (a uuid) is now `connection`, the connection's name.
- The spot's keys are the catalog's: `time` for `spot_time`, `reference` for `pota_reference`,
  `sota_summit_ref` and `wwff_reference`, `place_name` for `pota_park_name` and
  `wwff_reference_name`, `state` for the part of `pota_location` after the dash. `base_callsign`,
  `mode_family` and the raw `pota_location` are no longer sent.
- Times are whole seconds ending `Z` (or Unix seconds), not `+00:00` with fractions.
- A test request carries `X-LongLines-Test: true` and `"connection": "Test"`, where it used to
  send a spot with callsign `N0CALL`.

For a few minutes around the change a receiver may still get the old body.
