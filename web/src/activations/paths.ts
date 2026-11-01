// The one place an activation's paths and links are built. /activations/<id> is the canonical
// page; /<callsign>/activations/<id> only redirects to it, so nothing here builds that alias.

import { lookupPath } from "../profile/format";

/** "/activations/bt2bjhxdrues". */
export function activationPath(id: string): string {
  return `/activations/${encodeURIComponent(id)}`;
}

/** The canonical, shareable link of an activation page. */
export function activationUrl(origin: string, id: string): string {
  return `${origin}${activationPath(id)}`;
}

/** The callsign profile's Spotted activations tab, for a base call from SQL. */
export function activationsTabPath(base: string): string {
  const path = lookupPath(base);
  return path ? `${path}?tab=activations` : "/lookup";
}
