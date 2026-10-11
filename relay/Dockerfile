# Long Lines stream relay. Build from the repository root so the shared source
# adapters are in the context:
#   docker build -f relay/Dockerfile .
#   fly deploy . --config relay/fly.toml --dockerfile relay/Dockerfile --ha=false
FROM denoland/deno:alpine-2.9.7

WORKDIR /app
# The relay imports parsers from supabase/functions/_shared; keep the same layout.
COPY supabase/functions/_shared/ supabase/functions/_shared/
COPY relay/ relay/
RUN rm -rf relay/__tests__ supabase/functions/_shared/__tests__ \
  && deno cache --no-config relay/main.ts

USER deno
EXPOSE 8080
# 160 MB of V8 heap leaves room for the runtime inside a 256 MB machine.
CMD ["run", "--no-config", "--v8-flags=--max-old-space-size=160", \
  "--allow-net", \
  "--allow-env=LONGLINES_FUNCTIONS_URL,LONGLINES_RELAY_SECRET,RELAY_LOGIN_CALL,RELAY_HEALTH_PORT,LONGLINES_USER_AGENT_URL", \
  "relay/main.ts"]
