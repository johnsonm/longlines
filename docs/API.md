# Long Lines API

Manage your connections, destinations, callsign groups and goals from your own scripts,
bots and club tools. Everything the web app can change about these, the API can change too, and
the same rules and error messages apply.

Base URL: `https://api.longlines.io/v1`

The full reference is [openapi.yaml](openapi.yaml), an OpenAPI 3.1 description of every route,
body and response, with the limits, error statuses and the connection rules explained. Open it
in any OpenAPI viewer (for example paste it into [editor.swagger.io](https://editor.swagger.io)),
or generate a client from it.

## Quick start

Create a token on the **API tokens** page. Long Lines shows it once; copy it then. Send it in the
`Authorization` header on every request:

```sh
curl https://api.longlines.io/v1/connections \
  -H "Authorization: Bearer ll_live_…"
```

A token acts as you. Anyone who has it can change your connections and destinations, so keep it
out of source control. If one leaks, rotate or revoke it on the same page.

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

# A connection for POTA and SOTA spots of any member.
curl -X POST "$API/connections" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
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
