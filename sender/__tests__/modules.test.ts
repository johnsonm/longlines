import { assertEquals } from "@std/assert";
import { loadConfig } from "../config.ts";

function allowEnvList(): { dockerfile: string; allowed: string[] } {
  const dockerfile = Deno.readTextFileSync(new URL("../Dockerfile", import.meta.url));
  const allowed = /--allow-env=([^"]+)"/.exec(dockerfile)?.[1]?.split(",") ?? [];
  return { dockerfile, allowed };
}

Deno.test("the Docker image allows every environment variable the sender reads", () => {
  // postgres.js reads these two whatever options it is given (sender/db.ts).
  const read = new Set<string>(["PGAPPNAME", "PGTARGETSESSIONATTRS"]);
  loadConfig((name) => {
    read.add(name);
    return name === "SENDER_DATABASE_URL"
      ? "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
      : name === "LONGLINES_ALLOW_INSECURE_DESTINATIONS"
      ? "1"
      : undefined;
  });
  const { dockerfile, allowed } = allowEnvList();
  assertEquals([...read].filter((name) => !allowed.includes(name)), []);
  // And nothing more: an allowance no module reads is a variable an import could start reading unseen.
  assertEquals(allowed.filter((name) => !read.has(name)), []);
  // The image runs the shell with the heap bound the 256 MB machine needs, and no import map.
  assertEquals(dockerfile.includes("--v8-flags=--max-old-space-size=160"), true);
  assertEquals(dockerfile.includes('"--no-config"'), true);
  assertEquals(dockerfile.includes("deno cache --no-config sender/main.ts"), true);
});

Deno.test("the database client constructs under the image's --allow-env list", async () => {
  // A denied process.env read throws under `deno run` (not under `deno eval`), so
  // this has to be a child process with exactly the image's permissions.
  const { allowed } = allowEnvList();
  const script = new URL("./construct_client.ts", import.meta.url).pathname;
  const config = new URL("../deno.json", import.meta.url).pathname;
  const output = await new Deno.Command("deno", {
    args: ["run", "--config", config, "--no-lock", `--allow-env=${allowed.join(",")}`, script],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, stderr);
  assertEquals(new TextDecoder().decode(output.stdout).trim(), "constructed");
});
