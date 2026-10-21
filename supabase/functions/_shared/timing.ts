// The run time a cron-called function reports for the Health page. pg_net
// keeps no timing of its own (net._http_response.created is when its worker
// stored a batch of responses), so each function stamps
// `Server-Timing: total;dur=<ms>` on its response and record_health_sample
// copies it into cron_http_requests.run_seconds. The figure is the function's
// own time; cold start and the gateway are not in it.

export const SERVER_TIMING = "Server-Timing";

/** `total;dur=12.3`: milliseconds to one decimal. */
export function serverTiming(ms: number): string {
  return `total;dur=${Math.max(0, ms).toFixed(1)}`;
}

/** Runs the handler and stamps its response with the time it took. */
export async function timed(
  run: () => Promise<Response>,
  clock: () => number = () => performance.now(),
): Promise<Response> {
  const start = clock();
  const res = await run();
  res.headers.set(SERVER_TIMING, serverTiming(clock() - start));
  return res;
}
