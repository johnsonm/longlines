// CORS for functions the browser calls directly. The app's origin is not
// pinned here: credentials travel in the Authorization header, not cookies,
// and the anon key is public, so a wildcard origin adds no exposure.

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

/** The response to an OPTIONS preflight, or null when the request is not one. */
export function preflightResponse(req: Request): Response | null {
  return req.method === "OPTIONS"
    ? new Response(null, { status: 204, headers: corsHeaders() })
    : null;
}

/** JSON response carrying the CORS headers, plus any extra headers. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", ...headers },
  });
}
