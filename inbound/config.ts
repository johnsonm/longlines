// Inbound configuration from the environment (Fly secrets in production).

import { ConfigError } from "../supabase/functions/_shared/errors.ts";
import type { ReferenceProgram } from "../supabase/functions/_shared/reference_catalog.ts";

/** The FCC's weekly full amateur license file (inbound/licenses.ts). */
export const FCC_AMATEUR_ZIP = "https://data.fcc.gov/download/pub/uls/complete/l_amat.zip";

/** Each program's official reference list (inbound/catalogs.ts). */
export type CatalogUrls = Readonly<Record<ReferenceProgram, string>>;

/** The programs' published lists, checked 2026-10-26. */
export const CATALOG_URLS: CatalogUrls = {
  pota: "https://pota.app/all_parks_ext.csv",
  sota: "https://storage.sota.org.uk/summitslist.csv",
  wwff: "https://wwff.co/wwff-data/wwff_directory.csv",
};

export interface InboundConfig {
  /** Supabase functions base URL, e.g. https://<ref>.supabase.co/functions/v1 */
  functionsUrl: string;
  /** Sent as x-inbound-secret; matches LONGLINES_INBOUND_SECRET on the functions side. */
  inboundSecret: string;
  /** Callsign used to log in to the telnet servers. */
  loginCall: string;
  healthPort: number;
  /** Zip the weekly license load reads (inbound/licenses.ts); null when it is off. */
  licenseZipUrl: string | null;
  /** The lists the weekly reference load reads (inbound/catalogs.ts); null when it is off. */
  catalogUrls: CatalogUrls | null;
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
 * INBOUND_LICENSES: "off", another URL (a local copy), or unset for the FCC file.
 * Unset with local functions means off, so a local inbound worker run does not
 * download 160 MB from the FCC unless asked to (INBOUND_LICENSES=<FCC URL>).
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
    throw new ConfigError("INBOUND_LICENSES must be off or a URL", { cause: undefined });
  }
  const url = new URL(v);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new ConfigError("INBOUND_LICENSES must use https outside local development", {
      cause: undefined,
    });
  }
  return v;
}

/**
 * INBOUND_CATALOGS: "off", "on", or unset for on. Unset with local functions means off, so a local
 * inbound run does not download 60 MB of lists unless asked to (INBOUND_CATALOGS=on).
 */
function catalogUrls(value: string | undefined, localFunctions: boolean): CatalogUrls | null {
  const v = trimmed(value).toLowerCase();
  if (v === "") {
    if (localFunctions) {
      return null;
    }
    return CATALOG_URLS;
  }
  if (v === "off") {
    return null;
  }
  if (v === "on") {
    return CATALOG_URLS;
  }
  throw new ConfigError("INBOUND_CATALOGS must be on or off", { cause: undefined });
}

export function loadConfig(env: (name: string) => string | undefined): InboundConfig {
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
  let healthPort = env("INBOUND_HEALTH_PORT");
  if (healthPort === undefined) {
    healthPort = "8080";
  }
  const port = portNumber(healthPort, "INBOUND_HEALTH_PORT");
  return {
    functionsUrl,
    inboundSecret: required(env, "LONGLINES_INBOUND_SECRET"),
    loginCall: required(env, "INBOUND_LOGIN_CALL").toUpperCase(),
    healthPort: port,
    licenseZipUrl: licenseZipUrl(env("INBOUND_LICENSES"), local),
    catalogUrls: catalogUrls(env("INBOUND_CATALOGS"), local),
  };
}
