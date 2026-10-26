// Relay configuration from the environment (Fly secrets in production).

import { ConfigError } from "../supabase/functions/_shared/errors.ts";

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

/** Hosts allowed over plain http: local development only. */
export function isLocalHost(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "host.docker.internal"].includes(hostname);
}

/** The trimmed value, or "" when unset. */
function trimmed(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  return value.trim();
}

function required(env: (name: string) => string | undefined, name: string): string {
  const value = trimmed(env(name));
  if (value === "") {
    throw new ConfigError(`missing environment variable ${name}`, { cause: undefined });
  }
  return value;
}

/** A TCP port from an environment variable; throws naming the variable otherwise. */
export function portNumber(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`${name} must be a port number`, { cause: undefined });
  }
  return port;
}

/**
 * RELAY_LICENSES: "off", another URL (a local copy), or unset for the FCC file.
 * Unset with local functions means off, so a local relay run does not
 * download 160 MB from the FCC unless asked to (RELAY_LICENSES=<FCC URL>).
 */
function licenseZipUrl(value: string | undefined, localFunctions: boolean): string | null {
  const v = trimmed(value);
  if (v === "") {
    if (localFunctions) {
      return null;
    }
    return FCC_AMATEUR_ZIP;
  }
  if (v.toLowerCase() === "off") {
    return null;
  }
  if (!URL.canParse(v)) {
    throw new ConfigError("RELAY_LICENSES must be off or a URL", { cause: undefined });
  }
  const url = new URL(v);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new ConfigError("RELAY_LICENSES must use https outside local development", {
      cause: undefined,
    });
  }
  return v;
}

export function loadConfig(env: (name: string) => string | undefined): RelayConfig {
  const functionsUrl = required(env, "LONGLINES_FUNCTIONS_URL").replace(/\/+$/, "");
  if (!URL.canParse(functionsUrl)) {
    throw new ConfigError("LONGLINES_FUNCTIONS_URL must be a URL", { cause: undefined });
  }
  const url = new URL(functionsUrl);
  const local = isLocalHost(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new ConfigError("LONGLINES_FUNCTIONS_URL must use https outside local development", {
      cause: undefined,
    });
  }
  let healthPort = env("RELAY_HEALTH_PORT");
  if (healthPort === undefined) {
    healthPort = "8080";
  }
  const port = portNumber(healthPort, "RELAY_HEALTH_PORT");
  return {
    functionsUrl,
    relaySecret: required(env, "LONGLINES_RELAY_SECRET"),
    loginCall: required(env, "RELAY_LOGIN_CALL").toUpperCase(),
    healthPort: port,
    licenseZipUrl: licenseZipUrl(env("RELAY_LICENSES"), local),
  };
}
