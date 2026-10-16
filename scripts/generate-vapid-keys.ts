// Prints a new VAPID keypair as the LONGLINES_VAPID_* env lines the send-test
// and api functions read from the Edge env and the sender reads from its Fly
// secrets (the same pair in both). Writes nothing; see docs/OPERATIONS.md
// "Push notifications" for where the values go.
//
//   deno run scripts/generate-vapid-keys.ts mailto:you@example.com

import { generateVapidKeys } from "../supabase/functions/_shared/delivery/webpush.ts";

const subject = Deno.args[0] ?? "";
if (!subject.startsWith("mailto:")) {
  console.error("Usage: deno run scripts/generate-vapid-keys.ts mailto:you@example.com");
  Deno.exit(1);
}

const keys = await generateVapidKeys(subject);
console.log(`LONGLINES_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`LONGLINES_VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`LONGLINES_VAPID_SUBJECT=${keys.subject}`);
