# Long Lines outbound sender. Build from the repository root so the shared
# delivery modules are in the context:
#   docker build -f sender/Dockerfile .
#   fly deploy --config sender/fly.toml --ha=false
FROM denoland/deno:alpine-2.9.7

WORKDIR /app
# The sender imports the delivery modules from supabase/functions/_shared; keep the same layout.
COPY supabase/functions/_shared/ supabase/functions/_shared/
COPY sender/ sender/
COPY sender/deno.json /deno.json
# deno cache also fetches npm:postgres (sender/db.ts) into the image.
RUN rm -rf sender/__tests__ supabase/functions/_shared/__tests__ \
  && deno cache --config /deno.json sender/main.ts

USER deno
EXPOSE 8080
# 160 MB of V8 heap leaves room for the runtime inside a 256 MB machine.
# --allow-net is unrestricted because destinations are arbitrary public hosts
# (urlsafety.ts is the guard). --allow-env must name every variable the sender
# reads; reading any other one throws and the sender exits
# (sender/__tests__/modules.test.ts checks the list).
CMD ["run", "--config", "/deno.json", "--v8-flags=--max-old-space-size=160", \
  "--allow-net", \
  "--allow-env=SENDER_DATABASE_URL,SENDER_DATABASE_CA,SENDER_HEALTH_PORT,SENDER_POLL_MS,SENDER_CONCURRENCY,SENDER_STALE_MS,SENDER_STATS_MS,LONGLINES_VAPID_PUBLIC_KEY,LONGLINES_VAPID_PRIVATE_KEY,LONGLINES_VAPID_SUBJECT,LONGLINES_ALLOW_INSECURE_DESTINATIONS,PGAPPNAME,PGTARGETSESSIONATTRS", \
  "sender/main.ts"]
