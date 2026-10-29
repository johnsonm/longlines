// Where a Google sign-in returns to. Email sign-in carries the page the user was
// going to in router state (`from`), but router state doesn't survive the trip to
// Google, which always comes back to the site root (the Auth redirect allow list
// holds only that). So SignInPage keeps `from` in sessionStorage before leaving,
// and the site root (App's ToHome) goes there once the session is read.
//
// sessionStorage is a per-tab convenience: where it throws or is missing, nothing
// is kept and Google's sign-in lands on Home as before.

const KEY = "longlines.returnPath";
const MAX_LENGTH = 2048;

/**
 * A path on this site only: it starts with one "/" and is not protocol-relative
 * ("//host", or "/\host", which browsers read the same way), and it has no
 * control characters (browsers strip tabs and newlines, which could join "/\t/"
 * into "//"). Anything else is refused, so a stored value can't send anyone off
 * the site.
 */
export function isSafeReturnPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_LENGTH) return false;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Keeps `path` for the next arrival at the site root; an unsafe or missing path clears what was kept. */
export function saveReturnPath(path: string | undefined): void {
  try {
    const s = storage();
    if (!s) return;
    if (isSafeReturnPath(path)) s.setItem(KEY, path);
    else s.removeItem(KEY);
  } catch {
    // Storage full or blocked: Google's sign-in lands on Home.
  }
}

/** The kept path, if any and still safe, without clearing it. */
export function peekReturnPath(): string | null {
  try {
    const value = storage()?.getItem(KEY) ?? null;
    return isSafeReturnPath(value) ? value : null;
  } catch {
    return null;
  }
}

/** Forgets the kept path, so it is used once. */
export function clearReturnPath(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing kept that could be read back either.
  }
}
