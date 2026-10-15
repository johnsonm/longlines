# Long Lines API

Manage your subscriptions, destinations and callsign groups from your own scripts, bots and club
tools. Everything the web app can change about these, the API can change too, and the same rules
and error messages apply.

Base URL: `https://api.longlines.io/v1`

## Tokens

Create a token on the **API tokens** page. Long Lines shows it once; copy it then. A token looks
like `ll_live_7hq2…` followed by more letters and digits.

- **Access.** *Read only* tokens can only make `GET` requests. *Read and write* tokens can do
  everything below.
- **Expiry.** A token can expire after 30, 90 or 365 days, or never.
- **Rotate** gives a token a new secret, keeping its name, access and expiry. The old secret stops
  working immediately. The expiry window restarts from the rotation.
- **Revoke** deletes the token. It stops working immediately.
- You can have up to 10 tokens.

Send the token in the `Authorization` header on every request:

```sh
curl https://api.longlines.io/v1/subscriptions \
  -H "Authorization: Bearer ll_live_…"
```

A token acts as you. Anyone who has it can change your subscriptions and destinations, so keep it
out of source control. If one leaks, rotate or revoke it.

## Limits

- **Rate limit.** 60 requests per minute per token. Over the limit you get `429` with a
  `Retry-After` header giving the seconds until the next minute.
- **Request size.** A request body can be at most 256 KB.
- **List size.** A list in a request, such as `callsigns`, can hold at most 2,000 items, and a
  group at most 1,000 callsigns.

## Responses and errors

Successful responses are JSON. Creates return `201`, everything else `200`. Deletes return
`{"deleted": true}`.

Errors return `{"error": "<message>"}` with one of these statuses:

| Status | Meaning |
|---|---|
| 400 | The request was invalid. The message says why, for example "Give the subscription a name." |
| 401 | The token is missing, malformed, unknown, revoked or expired. |
| 403 | A read-only token tried to change something. |
| 404 | No such route, or the subscription, destination or group isn't yours. |
| 405 | The route exists but not with that method. The `Allow` header lists the methods it takes. |
| 409 | A destination or group is still used by a subscription. |
| 413 | The request body is too large. |
| 429 | Too many requests. See Limits. |
| 500 | Something went wrong on our side. Try again. |

Ids are UUIDs. Times are ISO 8601 in UTC.

## Destinations

A destination is where matching spots go: a Discord channel webhook, your own HTTPS webhook, or
push notifications to your devices. See [WEBHOOKS.md](WEBHOOKS.md) for the webhook payload and its
signature. The API never returns a destination's URL, only `url_display`, a masked form.

An account has at most one push destination. It has no URL (`url_display` is "Your devices") and
reaches every browser where you turned notifications on. Devices can only be added from a browser
signed in to Long Lines; the API creates, lists, tests and deletes the destination but doesn't
manage devices.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/destinations` | | All your destinations. |
| POST | `/destinations` | `{"type": "discord" or "webhook", "name", "url"}`, or `{"type": "push", "name"}` | The destination. A webhook also gets `signing_secret`, shown only here. A second push destination is a `400`: "You already have push notifications." |
| GET | `/destinations/{id}` | | The destination. |
| PATCH | `/destinations/{id}` | `{"name"?, "url"?}` | The destination. The type can't change, and a push destination takes no `url`. A new `url` clears `failing` health and the failure count. |
| DELETE | `/destinations/{id}` | | `{"deleted": true}`, or `409` while a subscription uses it. |
| POST | `/destinations/{id}/rotate-secret` | | `{"signing_secret"}`, for webhooks. The old secret stops working. |
| POST | `/destinations/{id}/test` | | `{"ok": true}` once a sample spot is delivered (for push, to at least one device), or `502` with the destination's error. |

A destination looks like this:

```json
{
  "id": "4b0e…", "type": "discord", "name": "Club #spots",
  "url_display": "https://discord.com/api/webhooks/1234…/abc",
  "health": "ok", "consecutive_failures": 0,
  "last_success_at": "2026-10-13T14:02:11Z", "last_error": null, "last_error_at": null,
  "created_at": "2026-10-01T18:30:00Z"
}
```

## Subscriptions

A subscription says which spots you want and where to send them.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required. |
| `enabled` | boolean | Defaults to `true`. |
| `sources` | strings | `pota`, `sotawatch`, `wwff`, `rbn`, `dxcluster`. Empty means any. A DX Cluster spot only matches a subscription that lists `dxcluster`, and a WWFF spot one that lists `wwff`. |
| `rules` | list of lists | The filter. See Rules. Defaults to `[]`, which passes every spot. |
| `quiet_minutes` | integer | 0, 5, 10, 30 or 60. Defaults to 10. |
| `destinations` | UUIDs | Zero or more. With none, the subscription stays off whatever `enabled` says, and starts once it has one. |

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/subscriptions` | | All your subscriptions. |
| POST | `/subscriptions` | All the fields above | The subscription. |
| GET | `/subscriptions/{id}` | | The subscription. |
| PUT | `/subscriptions/{id}` | All the fields above | The subscription. `sources` and `destinations` left out become empty; `rules`, `enabled` and `quiet_minutes` left out keep their values (send `"rules": []` to clear the filter). |
| PATCH | `/subscriptions/{id}` | Any of the fields above | The subscription. Fields left out keep their values, and so do `name`, `enabled` and `quiet_minutes` sent as `null`. A list can't be `null`: send `[]` to empty it. |
| DELETE | `/subscriptions/{id}` | | `{"deleted": true}` |

### Rules

`rules` is a list of groups, and each group is a list of rules. A spot passes when it passes every
rule in at least one group: rules in a group are joined by "and", and groups by "or". The web app
shows the same thing as one list where each rule after the first says And or Or, with And binding
tighter, so "band is 20m and mode is CW or callsign is W1AW" is:

```json
[
  [{"field": "band", "op": "is", "values": ["20m"]}, {"field": "mode", "op": "is", "values": ["cw"]}],
  [{"field": "callsign", "op": "is", "values": ["W1AW"]}]
]
```

| `field` | `op` | `values` |
|---|---|---|
| `callsign` | `is`, `is_not` | Calls, uppercased for you. A call matches exactly or by its base call. |
| `group` | `is`, `is_not` | Callsign group ids. A spot's base call is checked against the members. |
| `band` | `is`, `is_not` | Bands, for example `20m`. |
| `mode` | `is`, `is_not` | Modes or mode families, for example `cw`, `ft8`, `digital`. |
| `reference` | `contains`, `not_contains` | Text to look for in a POTA reference or location, a SOTA summit code or a WWFF reference, such as `US-NC` or `KFF-`. Ignores case. |
| `frequency` | `is`, `is_not`, `gt`, `lt` | One number, in kHz. `gt` is greater than and `lt` less than. |

`is` passes a spot that has any of the values and `is_not` one that has none of them, so a spot
with no band passes `band is_not 20m`. A subscription can have at most 50 rules, and each group
needs at least one.

RBN spots only pass a group that has a `callsign` or `group` rule with `is`, so a subscription
whose only source is `rbn` needs one in every group.

## Callsign groups

A group is a named list of up to 1,000 callsigns, such as a club roster. Point subscriptions at a
group with a `group` rule. Adding a member to the group changes what every subscription using it
matches, and you don't need to save the subscriptions again.

Members are stored as base calls: adding `KN4XYZ/P` stores `KN4XYZ`, which matches `KN4XYZ` and
any portable or prefixed form of it. Removing works the same way. A call that isn't a valid
callsign refuses the whole request with `400` and "Not a callsign: …", and nothing changes.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/groups` | | All your groups. |
| POST | `/groups` | `{"name", "callsigns"?: [...]}` | The group. Names are unique per account, ignoring case. |
| GET | `/groups/{id}` | | The group. |
| PATCH | `/groups/{id}` | `{"name"?, "callsigns"?: [...]}` | The group. A `callsigns` list replaces the whole member list. A `name` left out, or sent as `null`, stays. |
| DELETE | `/groups/{id}` | | `{"deleted": true}`, or `409` while a subscription uses it. |
| POST | `/groups/{id}/members` | `{"callsigns": [...]}` | The group, after adding. Calls already in the group are skipped. |
| POST | `/groups/{id}/members/remove` | `{"callsigns": [...]}` | The group, after removing. Calls not in the group are ignored. |

The two `members` routes change the list in one step, so two scripts adding members at the same
time don't lose each other's changes.

A group looks like this. `on_air` counts the members spotted in the last 30 minutes and carries the
newest of those spots; its `reference` is the POTA, SOTA or WWFF reference, whichever the spot has.

```json
{
  "id": "9c1d…", "name": "Club members", "callsigns": ["KK4PWJ", "N4DXX"],
  "member_count": 2, "subscription_count": 1, "updated_at": "2026-10-13T18:40:00Z",
  "on_air": {"count": 1, "latest": {"callsign": "KK4PWJ/P", "frequency_khz": 14062, "band": "20m",
             "mode": "CW", "source": "pota", "reference": "US-1234", "spot_time": "2026-10-13T18:31:07Z"}}
}
```

## Example: keep a club roster in sync

Set up once, in the web app or with the API:

```sh
TOKEN="ll_live_…"
API="https://api.longlines.io/v1"

# A Discord destination for the club channel.
curl -X POST "$API/destinations" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type": "discord", "name": "Club #spots", "url": "https://discord.com/api/webhooks/…"}'

# The roster group.
curl -X POST "$API/groups" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Club members"}'

# A subscription for POTA and SOTA spots of any member.
curl -X POST "$API/subscriptions" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "Members on the air", "sources": ["pota", "sotawatch"],
       "rules": [[{"field": "group", "op": "is", "values": ["<group id>"]}]],
       "destinations": ["<destination id>"]}'
```

Then, when someone joins or leaves:

```sh
curl -X POST "$API/groups/<group id>/members" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"callsigns": ["KN4XYZ"]}'

curl -X POST "$API/groups/<group id>/members/remove" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"callsigns": ["W1OLD"]}'
```
