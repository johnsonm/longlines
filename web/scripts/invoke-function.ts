// Calls one of the service-role Edge Functions on the local stack, the way cron does on the
// hosted project. Local cron has no Vault secrets, so this is how a run is triggered by hand.
//
//   node scripts/invoke-function.ts ingest-pota
//
// The ingest functions fetch from the real POTA and SOTAwatch APIs. Run them by hand only;
// never put this in a loop.
import { fail, localStatus } from "./local-stack.ts";

const FUNCTIONS = ["ingest-pota", "ingest-sotawatch", "ingest-wwff", "deliver"];

const name = process.argv[2] ?? "";
if (!FUNCTIONS.includes(name)) {
  fail(`usage: invoke-function.ts <${FUNCTIONS.join("|")}>`);
}

let status;
try {
  status = localStatus();
} catch (error) {
  fail((error as Error).message);
}

const url = `${status.apiUrl}/functions/v1/${name}`;
console.log(`→ POST ${url}`);

let response: Response;
try {
  response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${status.serviceRoleKey}` },
  });
} catch (error) {
  fail(
    `${(error as Error).message}. Are the functions being served? ` +
      "Run `npm run supabase:functions` (or `npm run dev:full`).",
  );
}

const body = await response.text();
let pretty = body;
try {
  pretty = JSON.stringify(JSON.parse(body), null, 2);
} catch {
  // Not JSON; print it as is.
}
console.log(`← ${response.status} ${response.statusText}\n${pretty}`);
if (!response.ok) {
  if (response.status === 503 || response.status === 404) {
    console.error(
      "\nThe gateway answered but the function did not. Is `npm run supabase:functions` running?",
    );
  }
  process.exit(1);
}
