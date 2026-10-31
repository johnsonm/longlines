---
title: Webhook
description: Send matched spots as signed JSON POST requests to your own HTTPS URL.
---

A webhook destination sends each matched spot to a URL you control, as an HTTPS POST with a JSON
body. Every request is signed so your server can check it came from Long Lines.

## Why you'd use it

You run a club's spot board or a home automation box, and you want every SOTA spot for your
association as structured data instead of a chat message.

## How it works

Long Lines POSTs JSON to your URL. With **One request per spot**, the body looks like this (default
fields):

```json
{
  "delivery_id": 48213,
  "connection": "W4C summits",
  "spot": {
    "id": 9123456,
    "time": "2026-10-17T17:42:09Z",
    "callsign": "KK4PWJ",
    "frequency_khz": 14062,
    "mode": "cw",
    "band": "20m",
    "source": "sotawatch",
    "reference": "W4C/CM-001",
    "spotter": "N4XYZ"
  }
}
```

`delivery_id` identifies the delivery, so you can recognize a retry. `connection` is the name of the
connection that matched. With a grouping interval, the body is `{"spots": [ ... ]}` instead, each item
shaped like the object above, up to 50 per request.

On the **Payload** card you choose which spot fields go in and in what order. The fields are Spot ID,
Time, Callsign, First name, Last name, Frequency, Mode, Band, Source, Reference, Place name, State,
Spotter, Country, Spot URL and Comment. Key names are fixed. You also choose:

- **Key style**: snake_case (`place_name`) or camelCase (`placeName`).
- **Time format**: **ISO 8601, UTC** (`2026-10-17T17:42:09Z`) or **Unix seconds** (`1792258929`).
- **Frequency unit**: kHz, MHz or Hz. The key changes with it (`frequency_khz`, `frequency_mhz`,
  `frequency_hz`).
- **When a spot has no value**: **Leave the key out** or **Send null**.

Source is sent as Long Lines' own id: `pota`, `sotawatch`, `wwff`, `wwbota`, `dxcluster`, `rbn`,
`logged` or `aprs`. An APRS-IS spot has no frequency, band or mode, so those follow **When a spot has
no value**. Mode is lower case. Comment is free text typed by the spotter; treat it as untrusted.

Each source's page under **Sources** shows its **Schema** and an **Example spot** with the default
keys.

### Headers and signature

Every request carries:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `LongLines/0.2` |
| `X-LongLines-Timestamp` | Unix seconds when the request was signed |
| `X-LongLines-Signature` | `sha256=` followed by a hex HMAC-SHA256 |
| `X-LongLines-Test` | `true`, on test requests only |

The signature is HMAC-SHA256, keyed with your signing secret, over the timestamp, a period and the raw
request body: `{timestamp}.{body}`. To check it, compute the same HMAC over the raw bytes you received
(before parsing the JSON), compare in constant time, and reject requests whose timestamp is more than
a few minutes old.

You can add up to 10 **Extra headers**, such as an API key your server expects. Their values are stored
encrypted and never shown again. You can't set headers Long Lines controls, such as `Content-Type`,
`Host`, `User-Agent` or anything starting with `X-LongLines-`.

### Failures and retries

A request fails when your server takes more than 10 seconds, answers with anything other than a 2xx
status, or redirects (redirects are never followed). **Retry a failed request** decides what happens
next:

| Setting | Retries |
| --- | --- |
| **Don't retry** | None |
| **Up to 3 times over 10 minutes** (default) | After 1, 3 and 6 minutes |
| **Keep trying for 24 hours** | After 30 seconds, 1, 2, 5 and 15 minutes, then every 30 minutes |

A spot still waiting after 24 hours is dropped whatever the setting. An HTTP 429 is a rate limit, not
a failure: Long Lines waits as your `Retry-After` header asks, then sends again.

With **Pause this destination after repeated failures** on (the default for new webhooks), 20 failed
requests in a row turn the destination off. Failures count at most once every 30 seconds, so a pause
takes at least 10 minutes of steady failure. A success restarts the count. When it pauses, the card
shows **Paused**, and the spots waiting for it are dropped.

### Allowed URLs

The URL must be `https://`. Long Lines refuses addresses inside private networks: `localhost`,
private and link-local IP ranges, names ending in `.local`, `.internal`, `.home.arpa` and similar, and
URLs with a username or password. It also checks where the name resolves before each request and
refuses a private address.

## Set it up

1. Open **Destinations**, select **Add destination**, pick **Webhook** and select **Continue**.
2. Enter a **Name**.
3. On the **Endpoint** card, enter the **Webhook URL**, such as
   `https://spots.example.org/longlines`.
4. Optionally, select **Add a header** and enter a **Header** and **Value**, such as `Authorization`
   and `Bearer abc123`.
5. On the **Payload** card, arrange the fields and choose the key style, time format, frequency unit
   and empty-value handling.
6. On the **Delivery** card, choose **Requests**, **Retry a failed request** and the pause switch.
7. Check the **Request preview**, which shows the path, headers and body exactly as they'll be sent.
8. Select **Add destination**.
9. The **Destination added** dialog shows your signing secret, `whsec_` followed by 48 characters. Copy
   it, store it with your server's config, check **I have saved the secret**, then select **Done**. You
   won't see it again.
10. Select **Send test request**. It sends a sample spot with `X-LongLines-Test: true`,
    `"connection": "Test"` and `"delivery_id": 0`, and shows the status your server returned. The test
    is not counted as a delivery.
11. Add the destination to a connection.

To replace a lost or leaked secret, select **Rotate** next to **Signing secret**. The new one takes
effect immediately and the old one stops working.

## Common setups

**Spot board.** **Requests**: One request per spot. Fields: Time, Callsign, Frequency, Mode, Band,
Source, Reference, Place name. **Frequency unit**: MHz. **Retry**: Don't retry, because an old spot
is no use on a live board.

**Archive into a database.** **Requests**: Group spots every 60 seconds. All fields, Comment
included. **When a spot has no value**: Send null, so every row has the same columns. **Retry**: Keep
trying for 24 hours.

**Script behind an API gateway.** Extra header `X-Api-Key` with your gateway key. **Key style**:
camelCase. **Time format**: Unix seconds.

## When it doesn't work

**"Use an https URL." or "That address is not allowed."** The URL isn't https, or it points at a
private address. Long Lines can't reach a server on your home network directly; put it behind a
public HTTPS endpoint.

**Send test shows "Your URL answered HTTP 401" (or 403).** Your server rejected the request. Check
your signature code and any extra header it expects.

**Signatures never match.** Compute the HMAC over the raw body bytes, not over JSON you parsed and
re-serialized. The signed string is the timestamp, a period, then the body.

**Paused.** The editor says "Paused 2 hours ago after repeated failed requests." Fix the server, turn
**Enabled** on and save. Spots that matched while it was paused are not resent.

**After changing the URL, my server gets no API key.** A new URL clears all extra header values, so
they never reach a host they weren't meant for. Enter them again before saving.

**I receive the same spot twice.** A retry after a timeout can repeat a delivery your server did
process. Use `delivery_id` to ignore repeats.

<!--
Verified against:
- web/src/destinations/WebhookEndpointCard.tsx, WebhookPayloadCard.tsx, WebhookDeliveryCard.tsx, WebhookPreviewCard.tsx, SigningSecretDialog.tsx, webhookModel.ts
- web/src/destinations/WebhookDestinationPage.tsx (Paused alert)
- supabase/migrations/20261018000300_webhook_destinations.sql (retry delays and attempts, pause spacing, header rules, 5 per claim, 50 per group)
- supabase/migrations/20261018000400_webhook_pause_default.sql (defaults)
- supabase/migrations/20261021000300_destination_names.sql (field order and keys)
- supabase/migrations/20261029000700_webhook_url_clears_headers.sql (URL change clears headers)
- supabase/migrations/20261028000500_local_cluster.sql (URL validation, 24 h max age)
- supabase/functions/_shared/delivery/send.ts (headers, 10 s timeout, no redirects), hmac.ts (signature), format.ts (body shapes), urlsafety.ts
- docs/WEBHOOKS.md (verification guidance)
The example body values are illustrative; keys match the defaults minus place_name/state, which a SOTA spot leaves out.
-->
