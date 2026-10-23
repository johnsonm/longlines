// Plain, explicit, Go-style TypeScript for the Deno code (Edge Functions, relay, sender, scripts).
import tseslint from "typescript-eslint";

// Ratchet: areas whose style refactor has not landed. The PR that fixes an area removes its
// globs, and nothing else edits this list. Deleted when empty.
const pendingStyle = [
  // handlers
  "supabase/functions/_shared/handlers/*.ts",
  "supabase/functions/_shared/api/*.ts",
  "supabase/functions/*/index.ts",
  "supabase/functions/_shared/serve.ts",
  "supabase/functions/_shared/serve_ingest.ts",
  "supabase/functions/_shared/cors.ts",
  "supabase/functions/_shared/auth.ts",
  "supabase/functions/_shared/timing.ts",
  "supabase/functions/_shared/signin.ts",
  "supabase/functions/_shared/__tests__/api_routes.test.ts",
  "supabase/functions/_shared/__tests__/api_token.test.ts",
  "supabase/functions/_shared/__tests__/app_config.test.ts",
  "supabase/functions/_shared/__tests__/auth.test.ts",
  "supabase/functions/_shared/__tests__/cors.test.ts",
  "supabase/functions/_shared/__tests__/fake_supabase.ts",
  "supabase/functions/_shared/__tests__/function_config.test.ts",
  "supabase/functions/_shared/__tests__/handlers_api.test.ts",
  "supabase/functions/_shared/__tests__/handlers_archive.test.ts",
  "supabase/functions/_shared/__tests__/handlers_band_map.test.ts",
  "supabase/functions/_shared/__tests__/handlers_callsign_profile.test.ts",
  "supabase/functions/_shared/__tests__/handlers_convert_archive.test.ts",
  "supabase/functions/_shared/__tests__/handlers_delete_account.test.ts",
  "supabase/functions/_shared/__tests__/handlers_group_page.test.ts",
  "supabase/functions/_shared/__tests__/handlers_health.test.ts",
  "supabase/functions/_shared/__tests__/handlers_import_cty.test.ts",
  "supabase/functions/_shared/__tests__/handlers_load_licenses.test.ts",
  "supabase/functions/_shared/__tests__/handlers_relay_status.test.ts",
  "supabase/functions/_shared/__tests__/handlers_sign_in.test.ts",
  "supabase/functions/_shared/__tests__/handlers_test_delivery.test.ts",
  "supabase/functions/_shared/__tests__/openapi.test.ts",
  "supabase/functions/_shared/__tests__/profile_lock_db.test.ts",
  "supabase/functions/_shared/__tests__/serve.test.ts",
  "supabase/functions/_shared/__tests__/serve_ingest.test.ts",
  "supabase/functions/_shared/__tests__/signin.test.ts",
  "supabase/functions/_shared/__tests__/timing.test.ts",
  // delivery
  "supabase/functions/_shared/delivery/*.ts",
  "supabase/functions/_shared/__tests__/delivery_format.test.ts",
  "supabase/functions/_shared/__tests__/delivery_hmac.test.ts",
  "supabase/functions/_shared/__tests__/delivery_run.test.ts",
  "supabase/functions/_shared/__tests__/delivery_send.test.ts",
  "supabase/functions/_shared/__tests__/delivery_urlsafety.test.ts",
  "supabase/functions/_shared/__tests__/pinned_http.test.ts",
  "supabase/functions/_shared/__tests__/webpush.test.ts",
  // relay
  "relay/*.ts",
  "relay/__tests__/*.ts",
  // sender
  "sender/*.ts",
  "sender/__tests__/*.ts",
];

const deno = ["supabase/functions/**/*.ts", "relay/**/*.ts", "sender/**/*.ts", "scripts/**/*.ts"];

export default tseslint.config(
  { ignores: ["deno.d.ts", "node_modules/", "web/", ...pendingStyle] },
  ...tseslint.configs.strictTypeChecked,
  {
    files: deno,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-ternary": "error",
      "curly": ["error", "all"],
      "eqeqeq": ["error", "always"],
      "max-statements-per-line": ["error", { max: 1 }],
      "func-style": ["error", "declaration"],
      "prefer-const": "error",
      "no-var": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/strict-boolean-expressions": ["error", {
        allowString: false,
        allowNumber: false,
        allowNullableObject: false,
      }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-restricted-syntax": [
        "error",
        { selector: "ObjectPattern", message: "No destructuring. Access fields directly." },
        { selector: "ArrayPattern", message: "No destructuring. Index explicitly." },
        { selector: "SpreadElement", message: "No spread. Build the value explicitly." },
        { selector: "ChainExpression", message: "No optional chaining. Check null with if." },
        { selector: "LogicalExpression[operator='??']", message: "No ??. Check null with if." },
        {
          selector: "AssignmentExpression[operator='??=']",
          message: "No ??=. Check null with if.",
        },
        {
          selector: "CallExpression[callee.property.name='then']",
          message: "Use await, not .then().",
        },
        { selector: "CallExpression[callee.property.name='reduce']", message: "Use a for loop." },
        {
          selector: "ArrowFunctionExpression > BlockStatement",
          message: "Arrow functions must be one-line expressions. Use a named function.",
        },
      ],
    },
  },
  // Deferred to Part 2: narrowing rules, enabled per area as Zod schemas land.
  {
    files: deno,
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  // Tests: syntax and style bans apply; fixture-typing rules do not.
  {
    files: ["**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
);
