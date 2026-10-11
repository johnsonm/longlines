// The callsigns to forward for one feed, refreshed from the Edge Function.
// A failed refresh keeps the last good list; until the first success nothing
// is forwarded.

export class Watchlist {
  #calls = new Set<string>();
  loaded = false;

  has(callsign: string): boolean {
    return this.#calls.has(callsign);
  }

  get size(): number {
    return this.#calls.size;
  }

  replace(callsigns: readonly string[]): void {
    this.#calls = new Set(callsigns.map((c) => c.trim().toUpperCase()).filter((c) => c !== ""));
    this.loaded = true;
  }

  /** Refresh once; returns false (and keeps the current list) on failure. */
  async refresh(fetchList: () => Promise<string[]>, log: (m: string) => void): Promise<boolean> {
    try {
      const before = this.loaded ? this.size : null;
      this.replace(await fetchList());
      if (this.size !== before) log(`watchlist: ${this.size} callsigns`);
      return true;
    } catch (error) {
      log(`watchlist refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
