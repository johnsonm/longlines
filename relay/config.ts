// Relay configuration from the environment (Fly secrets in production).

/** The FCC's weekly full amateur license file (relay/licenses.ts). */
export const FCC_AMATEUR_ZIP = "https://data.fcc.gov/download/pub/uls/complete/l_amat.zip";

export interface RelayConfig {
  /** Supabase functions base URL, e.g. https://<ref>.supabase.co/functions/v1 */
  functionsUrl: string;
  /** Sent as x-relay-secret; matches LONGLINES_RELAY_SECRET on the functions side. */
  relaySecret: string;
  /** Callsign used to log in to the telnet servers. */
  loginCall: string;
  healthPort: number;
  /** Zip the weekly license load reads (relay/licenses.ts); null when it is off. */
  licenseZipUrl: string | null;
}

function required(env: (name: string) => string | undefined, name: string): string {
  const value = env(name)?.trim();
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

/** A TCP port from an environment variable; throws naming the variable otherwise. */
export function portNumber(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be a port number`);
  }
  return port;
}

/**
 * RELAY_LICENSES: "off", another URL (a local copy), or unset for the FCC file.
 * Unset with local functions means off, so a local relay run does not
 * download 160 MB from the FCC unless asked to (RELAY_LICENSES=<FCC URL>).
 */
function licenseZipUrl(value: string | undefined, localFunctions: boolean): string | null {
  const v = value?.trim();
  if (!v) return localFunctions ? null : FCC_AMATEUR_ZIP;
  if (v.toLowerCase() === "off") return null;
  if (!/^https?:\/\//.test(v)) throw new Error("RELAY_LICENSES must be off or a URL");
  return v;
}

export function loadConfig(env: (name: string) => string | undefined): RelayConfig {
  const functionsUrl = required(env, "LONGLINES_FUNCTIONS_URL").replace(/\/+$/, "");
  const url = new URL(functionsUrl);
  const local = ["127.0.0.1", "localhost", "host.docker.internal"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("LONGLINES_FUNCTIONS_URL must use https outside local development");
  }
  const port = portNumber(env("RELAY_HEALTH_PORT") ?? "8080", "RELAY_HEALTH_PORT");
  return {
    functionsUrl,
    relaySecret: required(env, "LONGLINES_RELAY_SECRET"),
    loginCall: required(env, "RELAY_LOGIN_CALL").toUpperCase(),
    healthPort: port,
    licenseZipUrl: licenseZipUrl(env("RELAY_LICENSES"), local),
  };
}
