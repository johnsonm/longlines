---
title: API tokens
description: Manage your connections, groups, destinations and goals from your own scripts with the Long Lines API.
---

An API token lets your own scripts and club tools use the Long Lines management API. A token acts as
you, limited to the access you give it. It can manage connections, callsign groups, destinations and
goals; it can't read spots.

## Why you'd use it

Your club keeps its roster in a spreadsheet. A nightly script with a **Read and write** token adds new
members to the club's callsign group and removes lapsed ones, so the club's Discord alerts stay
current without anyone editing the group by hand.

## How it works

The base URL is `https://api.longlines.io/v1`. Send the token in the `Authorization` header:

```sh
curl https://api.longlines.io/v1/connections \
  -H "Authorization: Bearer ll_live_..."
```

| Resource | Paths |
| --- | --- |
| Destinations | `/destinations`, `/destinations/{id}`, `/destinations/{id}/rotate-secret`, `/destinations/{id}/test` |
| Connections | `/connections`, `/connections/{id}` |
| Callsign groups | `/groups`, `/groups/{id}`, `/groups/{id}/members`, `/groups/{id}/members/remove` |
| Goals | `/goals`, `/goals/{id}`, `/goals/{id}/entries`, `/goals/{id}/reviews` |

The full reference is the [OpenAPI file](https://github.com/sonyccd/longlines/blob/main/docs/openapi.yaml)
in the Long Lines repository.

Limits and behavior:

- **Read only** tokens can make GET requests only. A write gets HTTP 403 "This token is read only."
- 60 requests a minute per token. Over that you get HTTP 429 with a `Retry-After` header.
- Request bodies up to 256 KB; lists in a request up to 2,000 items.
- The same account limits as the web app: 100 connections, 50 destinations, 50 groups, 50 goals.
- The API never returns a destination's URL or signing secret, except the secret once when you create
  or rotate a webhook.
- It can't manage push devices, change Discord, push or webhook display settings or webhook headers,
  make a group's statistics page public, copy a goal, or create a Local DX cluster destination. Use the
  web app for those.
- Relay tokens are separate and can't call this API.

You can have up to 10 tokens.

## Set it up

1. Open **API tokens** and select **New token**.
2. Enter a **Name**, such as `Club roster sync`.
3. Choose **Access**: **Read only** or **Read and write**.
4. Choose **Expires**: **Never**, **In 30 days**, **In 90 days** or **In a year**.
5. Select **Create token**.
6. Copy the token from **Copy your token** and store it where your script can read it. You won't see it
   again. Select **Done**.

The table lists each token with its first characters, access, created date, last use and expiry.
**Rotate** issues a new token with the same name, access and expiry length (the expiry restarts from
now); scripts using the old one stop working at once. **Revoke** deletes it.

## Common setups

**Club roster sync.** **Read and write**, **Never** expires. The script posts new calls to
`/groups/{id}/members` and removed ones to `/groups/{id}/members/remove`.

**Dashboard of your connections.** **Read only**, **In a year**. The script GETs `/connections` and
`/destinations` to show what's set up and which destinations are failing.

**Seasonal goal setup.** **Read and write**, **In 30 days**. A one-off script creates this year's goals
with POST `/goals`.

## When it doesn't work

**HTTP 401 "Missing or invalid API token."** The header is missing, the token was mistyped, revoked or
rotated, or it expired.

**HTTP 403 "This token is read only."** Create a **Read and write** token for writes.

**HTTP 429 "Too many requests. Try again in a minute."** Wait for the `Retry-After` seconds.

**HTTP 400 "Add a Local DX cluster destination in the web app."** That type can only be made in the
web app.

**"You can have up to 10 tokens. Delete one first."** Revoke a token you no longer use.

<!--
Verified against:
- web/src/tokens/ApiTokensPage.tsx, model.ts (labels, options, Using the API card)
- supabase/functions/_shared/api/routes.ts (paths), handlers/api.ts (401/403/429 messages, 60 a minute, 256 KB)
- supabase/migrations/20261013000300_management_api.sql (10-token cap, rotate keeps expiry length)
- supabase/migrations/20261028000500_local_cluster.sql (local_cluster refused)
- docs/openapi.yaml (scopes, limits, what the API can't do)
Flagged: the page's "API docs" button links to docs/API.md on GitHub, not to this site; the page intro omits goals.
-->
