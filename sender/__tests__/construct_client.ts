// Run by modules.test.ts in a child Deno with the image's exact --allow-env
// list: constructing the client must not read any environment variable the
// list leaves out (a denied read throws NotCapable, which would exit 1 here as
// it would on Fly). Nothing connects; postgres.js opens a socket on the first
// statement only. The test runner loads every module in this directory, so
// the construction runs only when this file is the entrypoint.
import { createClient } from "../db.ts";

if (import.meta.main) {
  createClient({ databaseUrl: "postgresql://u:pw@127.0.0.1:1/postgres", databaseSsl: false });
  console.log("constructed");
}
