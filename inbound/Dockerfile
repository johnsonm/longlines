# Long Lines inbound worker. Build from the repository root so the shared source
# adapters are in the context:
#   docker build -f inbound/Dockerfile .
#   fly deploy --config inbound/fly.toml --ha=false
FROM denoland/deno:alpine-2.9.7

WORKDIR /app
# The inbound worker imports parsers from supabase/functions/_shared; keep the same layout.
COPY supabase/functions/_shared/ supabase/functions/_shared/
COPY inbound/ inbound/
COPY inbound/deno.json /deno.json
RUN rm -rf inbound/__tests__ supabase/functions/_shared/__tests__ \
  && deno cache --config /deno.json inbound/main.ts

USER deno
EXPOSE 8080
# 160 MB of V8 heap leaves room for the runtime inside a 256 MB machine.
# --allow-env must name every variable the inbound worker reads; reading any other one
# throws and the inbound worker exits (inbound/__tests__/modules.test.ts checks the list).
CMD ["run", "--config", "/deno.json", "--v8-flags=--max-old-space-size=160", \
  "--allow-net", \
  "--allow-env=LONGLINES_FUNCTIONS_URL,LONGLINES_INBOUND_SECRET,INBOUND_LOGIN_CALL,INBOUND_HEALTH_PORT,LONGLINES_USER_AGENT_URL,DXCLUSTER_HOST,DXCLUSTER_PORT,INBOUND_LICENSES,INBOUND_CATALOGS,APRS_LOGIN_CALL,APRS_HOST,APRS_PORT", \
  "inbound/main.ts"]
