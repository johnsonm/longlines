/**
 * Memoize an async loader across visits to /stats for as long as its last
 * result is fresh, so a snapshot is fetched once per hour no matter how often
 * the user navigates to and from the page, and never polled. `freshUntil`
 * returns the epoch millisecond the value expires at, or null for a value that
 * must not be kept (the page uses that for "no snapshot yet"). A rejected load
 * is forgotten so the next visit can try again. `peek` is the synchronous
 * read a mounting component uses to skip its loading state; `put` keeps a
 * value obtained some other way as if it had been loaded.
 */
export interface Cached<T> {
  get(): Promise<T>;
  peek(): T | undefined;
  put(value: T): void;
}

export function cached<T>(load: () => Promise<T>, freshUntil: (value: T) => number | null, now: () => number = Date.now): Cached<T> {
  let pending: Promise<T> | null = null;
  let kept: { value: T; until: number } | null = null;
  const fresh = (): T | undefined => (kept !== null && now() < kept.until ? kept.value : undefined);
  const keep = (value: T) => {
    const until = freshUntil(value);
    kept = until === null ? null : { value, until };
  };
  return {
    peek: fresh,
    put: keep,
    get() {
      const value = fresh();
      if (value !== undefined) return Promise.resolve(value);
      pending ??= load()
        .then((loaded) => {
          keep(loaded);
          return loaded;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}

/**
 * `cached` per key: each key gets its own loader, freshness and in-flight
 * request. Callsign profiles use it so going back to a profile seen a minute
 * ago renders it at once instead of asking the Edge Function again.
 */
export interface KeyedCached<T> {
  get(key: string): Promise<T>;
  peek(key: string): T | undefined;
  put(key: string, value: T): void;
}

export function keyedCached<T>(
  load: (key: string) => Promise<T>,
  freshUntil: (value: T) => number | null,
  now: () => number = Date.now,
): KeyedCached<T> {
  const entries = new Map<string, Cached<T>>();
  const entry = (key: string): Cached<T> => {
    let found = entries.get(key);
    if (!found) {
      found = cached(() => load(key), freshUntil, now);
      entries.set(key, found);
    }
    return found;
  };
  return {
    get: (key) => entry(key).get(),
    peek: (key) => entries.get(key)?.peek(),
    put: (key, value) => entry(key).put(value),
  };
}
