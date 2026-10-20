/**
 * Analytics and Speed Insights record the page URL. Recovery and confirmation
 * links carry auth tokens in the hash (and PKCE codes in the query), and the
 * report can go out before supabase-js strips them, so neither is ever sent.
 * Used as `beforeSend` by both.
 */
export function withoutQueryOrHash<E extends { url: string }>(event: E): E {
  const cut = event.url.search(/[?#]/);
  return cut === -1 ? event : { ...event, url: event.url.slice(0, cut) };
}
