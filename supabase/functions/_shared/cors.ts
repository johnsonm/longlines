// CORS for functions the browser calls directly. The app's origin is not
// pinned here: credentials travel in the Authorization header, not cookies,
// and the anon key is public, so a wildcard origin adds no exposure.

/** Methods a function takes unless it names its own. */
export const DEFAULT_METHODS = "GET, POST, OPTIONS";

/** How long a browser may reuse a preflight answer, in seconds. */
export const PREFLIGHT_MAX_AGE = "600";

// Retry-After (429) and Allow (405) are readable by browser code, so it can back off.
export function corsHeaders(methods: string = DEFAULT_METHODS): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Expose-Headers": "Retry-After, Allow",
  };
}

/** The response to an OPTIONS preflight, or null when the request is not one. */
export function preflightResponse(
  req: Request,
  methods: string = DEFAULT_METHODS,
): Response | null {
  return req.method === "OPTIONS"
    ? new Response(null, {
      status: 204,
      headers: { ...corsHeaders(methods), "Access-Control-Max-Age": PREFLIGHT_MAX_AGE },
    })
    : null;
}

/** JSON response carrying the CORS headers, plus any extra headers. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", ...headers },
  });
}
