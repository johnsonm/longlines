/**
 * home_flow()'s payload, pinned by supabase/tests/home_flow.test.sql: the caller's
 * last 24 hours of deliveries, and which sources each connection takes spots from.
 * `matched` counts distinct spots, `delivered` sent rows (one per destination). A
 * connection with no row in `subscriptions` matched nothing that was recorded.
 */
export interface HomeFlow {
  matched: number;
  delivered: number;
  /** Distinct matched spots per spot source. */
  sources: { source: string; matched: number }[];
  /** Matched spots per connection and spot source. */
  subscriptions: { subscription_id: string; source: string; matched: number }[];
  /** Sent spots per connection and destination. */
  links: { subscription_id: string; destination_id: string; delivered: number }[];
  /** Every connection's sources as the matcher reads them ("any" expanded, RBN only with stations), traffic or not. */
  subscription_sources: { subscription_id: string; source: string }[];
}
