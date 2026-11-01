/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// /sw.js is registered as a classic worker, which cannot load other chunks. If
// the app ever imports from src/pwa/sw-handlers.ts, Rolldown would split the
// shared code out and sw.js would start with an import; fail the build instead.
function standaloneServiceWorker(): Plugin {
  return {
    name: "standalone-service-worker",
    generateBundle(_options, bundle) {
      const sw = bundle["sw.js"];
      if (sw?.type === "chunk" && (sw.imports.length > 0 || sw.dynamicImports.length > 0)) {
        this.error(`sw.js must be self-contained but imports ${[...sw.imports, ...sw.dynamicImports].join(", ")}`);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Vite only exposes VITE_* variables to the browser. The Supabase/Vercel
  // integration provides SUPABASE_URL and SUPABASE_ANON_KEY (and NEXT_PUBLIC_
  // copies) instead, so map exactly those two public values onto the names the
  // app reads, plus the public contact address shown on callsign profiles.
  // Nothing else is read here; the service-role key in particular must never
  // reach the bundle.
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  const url = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    env.SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  const contactEmail = env.VITE_CONTACT_EMAIL ?? env.CONTACT_EMAIL ?? "";
  // The VAPID public key is public by design (the browser hands it to the push
  // service); the private key stays in the sender's and the Edge Functions' env.
  const vapidPublicKey = env.VITE_VAPID_PUBLIC_KEY ?? env.VAPID_PUBLIC_KEY ?? env.LONGLINES_VAPID_PUBLIC_KEY ?? "";
  // The Sentry DSN is public too (it can only send events). Vercel's build env
  // supplies the commit and VERCEL_ENV, so events carry the release and
  // production vs preview; without a DSN the app never starts Sentry.
  const sentryDsn = env.VITE_SENTRY_DSN ?? env.SENTRY_DSN ?? "";
  const sentryRelease = env.SENTRY_RELEASE ?? env.VERCEL_GIT_COMMIT_SHA ?? "";
  const sentryEnvironment = env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV ?? mode;
  // Build-time only, never in the bundle: with a token the build uploads its
  // source maps to Sentry and deletes them, so Vercel never serves them.
  const sentryAuthToken = env.SENTRY_AUTH_TOKEN ?? "";
  if (!url || !anonKey) {
    console.warn("vite: SUPABASE_URL / SUPABASE_ANON_KEY (or VITE_ equivalents) are not set; the app will fail at startup.");
  }
  if (!vapidPublicKey) {
    console.warn("vite: VAPID_PUBLIC_KEY (or LONGLINES_VAPID_PUBLIC_KEY) is not set; push notifications will be unsupported.");
  }
  return {
    plugins: [
      react(),
      standaloneServiceWorker(),
      ...(sentryAuthToken
        ? [sentryVitePlugin({
          org: env.SENTRY_ORG ?? "long-lines",
          project: env.SENTRY_PROJECT ?? "longlines-web",
          authToken: sentryAuthToken,
          release: { name: sentryRelease || undefined },
          sourcemaps: { filesToDeleteAfterUpload: ["dist/**/*.map"] },
          telemetry: false,
        })]
        : []),
    ],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(url),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(anonKey),
      "import.meta.env.VITE_CONTACT_EMAIL": JSON.stringify(contactEmail),
      "import.meta.env.VITE_VAPID_PUBLIC_KEY": JSON.stringify(vapidPublicKey),
      "import.meta.env.VITE_SENTRY_DSN": JSON.stringify(sentryDsn),
      "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(sentryRelease),
      "import.meta.env.VITE_SENTRY_ENVIRONMENT": JSON.stringify(sentryEnvironment),
    },
    // In dev the app registers /src/pwa/sw.ts; this lets it take the root scope.
    server: { headers: { "Service-Worker-Allowed": "/" } },
    build: {
      // "hidden": maps for the Sentry upload, with no sourceMappingURL comment in the bundle.
      sourcemap: sentryAuthToken ? "hidden" : false,
      // Every flag-icons SVG stays a file of its own, fetched only when a
      // profile shows it (src/profile/flags.ts); inlining would put hundreds
      // of flags into the main bundle.
      assetsInlineLimit: (file) => (file.includes("/flag-icons/") ? false : undefined),
      rolldownOptions: {
        // The service worker is a second entry with a fixed name: browsers find
        // it at /sw.js, and vercel.json serves that path no-cache.
        input: { main: "index.html", sw: "src/pwa/sw.ts" },
        output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
      },
    },
    test: {
      // Pure modules run in node. Anything that renders (*.test.tsx) runs in
      // jsdom; it can't be the default because Vite applies its browser file
      // guard there, which blocks states.test.ts from reading the migrations.
      projects: [
        // api/ holds the Vercel link-preview functions (Node, never in the Vite build).
        { extends: true, test: { name: "node", include: ["src/**/*.test.ts", "api/**/*.test.ts"], environment: "node" } },
        {
          extends: true,
          test: {
            name: "dom",
            include: ["src/**/*.test.tsx"],
            environment: "jsdom",
            setupFiles: ["src/test/setup.ts"],
            // MUI renders plus user-event typing run well past 5s per test under coverage on a loaded machine.
            testTimeout: 15_000,
          },
        },
      ],
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}", "api/**/*.ts"],
        exclude: [
          "src/**/*.test.{ts,tsx}",
          "api/**/*.test.ts",
          "src/test/**",
          // Generated by `supabase gen types`.
          "src/lib/database.types.ts",
          // Mounts <App /> into index.html; nothing to assert.
          "src/main.tsx",
          // Calls Sentry.init with lib/sentry.ts's options, which are tested.
          "src/instrument.ts",
          // Event listeners that hand the real worker globals to sw-handlers.ts, which is tested.
          "src/pwa/sw.ts",
        ],
        reporter: ["text-summary", "text", "lcov"],
        thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
      },
    },
  };
});
