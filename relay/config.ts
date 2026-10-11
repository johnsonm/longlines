// Relay configuration from the environment (Fly secrets in production).

export interface RelayConfig {
  /** Supabase functions base URL, e.g. https://<ref>.supabase.co/functions/v1 */
  functionsUrl: string;
  /** Sent as x-relay-secret; matches LONGLINES_RELAY_SECRET on the functions side. */
  relaySecret: string;
  /** Callsign used to log in to the telnet servers. */
  loginCall: string;
  healthPort: number;
}

function required(env: (name: string) => string | undefined, name: string): string {
  const value = env(name)?.trim();
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

export function loadConfig(env: (name: string) => string | undefined): RelayConfig {
  const functionsUrl = required(env, "LONGLINES_FUNCTIONS_URL").replace(/\/+$/, "");
  const url = new URL(functionsUrl);
  const local = ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("LONGLINES_FUNCTIONS_URL must use https outside local development");
  }
  const port = Number(env("RELAY_HEALTH_PORT") ?? "8080");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("RELAY_HEALTH_PORT must be a port number");
  }
  return {
    functionsUrl,
    relaySecret: required(env, "LONGLINES_RELAY_SECRET"),
    loginCall: required(env, "RELAY_LOGIN_CALL").toUpperCase(),
    healthPort: port,
  };
}
