// The one place an activation's page and link are built. /activations/<id> is the canonical
// page; /<callsign>/activations/<id> only redirects to it, so nothing here builds that alias.
// The callsign profile's Spotted activations tab is a profile path (activationsTabPath in
// profile/format.ts). Import-free, so the link previews (web/api) load it from Node.

/** "/activations/bt2bjhxdrues". */
export function activationPath(id: string): string {
  return `/activations/${encodeURIComponent(id)}`;
}

/** The canonical, shareable link of an activation page. */
export function activationUrl(origin: string, id: string): string {
  return `${origin}${activationPath(id)}`;
}
