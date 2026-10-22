# Long Lines stream relay. Build from the repository root so the shared source
# adapters are in the context:
#   docker build -f relay/Dockerfile .
#   fly deploy --config relay/fly.toml --ha=false
FROM denoland/deno:alpine-2.9.7

WORKDIR /app
# The relay imports parsers from supabase/functions/_shared; keep the same layout.
COPY supabase/functions/_shared/ supabase/functions/_shared/
COPY relay/ relay/
COPY relay/deno.json /deno.json
RUN rm -rf relay/__tests__ supabase/functions/_shared/__tests__ \
  && deno cache --config /deno.json relay/main.ts

USER deno
EXPOSE 8080
# 160 MB of V8 heap leaves room for the runtime inside a 256 MB machine.
# --allow-env must name every variable the relay reads; reading any other one
# throws and the relay exits (relay/__tests__/modules.test.ts checks the list).
CMD ["run", "--config", "/deno.json", "--v8-flags=--max-old-space-size=160", \
  "--allow-net", \
  "--allow-env=LONGLINES_FUNCTIONS_URL,LONGLINES_RELAY_SECRET,RELAY_LOGIN_CALL,RELAY_HEALTH_PORT,LONGLINES_USER_AGENT_URL,DXCLUSTER_HOST,DXCLUSTER_PORT,RELAY_LICENSES,APRS_LOGIN_CALL,APRS_HOST,APRS_PORT", \
  "relay/main.ts"]
