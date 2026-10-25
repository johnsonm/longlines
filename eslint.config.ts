// Plain, explicit, Go-style TypeScript for the Deno code (Edge Functions, relay, sender, scripts).
import tseslint from "typescript-eslint";

// Ratchet: areas whose Zod and error-handling refactor (Part 2) has not landed. They keep Part 1's
// rules and skip the Part 2 ones. The PR that converts an area removes its globs, and nothing else
// edits this list. Deleted when empty.
const zodPending = [
  // ingest
  "supabase/functions/_shared/pota.ts",
  "supabase/functions/_shared/sotawatch.ts",
  "supabase/functions/_shared/wwff.ts",
  "supabase/functions/_shared/dxcluster.ts",
  "supabase/functions/_shared/rbn.ts",
  "supabase/functions/_shared/rbn_push.ts",
  "supabase/functions/_shared/aprs.ts",
  "supabase/functions/_shared/relay_lines.ts",
  "supabase/functions/_shared/ingest.ts",
  "supabase/functions/_shared/normalize.ts",
  "supabase/functions/_shared/modes.ts",
  "supabase/functions/_shared/bands.ts",
  "supabase/functions/_shared/hash.ts",
  "supabase/functions/_shared/strip_nul.ts",
  "supabase/functions/_shared/types.ts",
  "supabase/functions/_shared/db.ts",
  "supabase/functions/_shared/http.ts",
  "supabase/functions/_shared/hmac.ts",
  "supabase/functions/_shared/__tests__/aprs.test.ts",
  "supabase/functions/_shared/__tests__/bands.test.ts",
  "supabase/functions/_shared/__tests__/db.test.ts",
  "supabase/functions/_shared/__tests__/dxcluster.test.ts",
  "supabase/functions/_shared/__tests__/hash.test.ts",
  "supabase/functions/_shared/__tests__/http.test.ts",
  "supabase/functions/_shared/__tests__/ingest.test.ts",
  "supabase/functions/_shared/__tests__/modes.test.ts",
  "supabase/functions/_shared/__tests__/normalize.test.ts",
  "supabase/functions/_shared/__tests__/pota.test.ts",
  "supabase/functions/_shared/__tests__/rbn.test.ts",
  "supabase/functions/_shared/__tests__/rbn_push.test.ts",
  "supabase/functions/_shared/__tests__/relay_lines.test.ts",
  "supabase/functions/_shared/__tests__/sotawatch.test.ts",
  "supabase/functions/_shared/__tests__/strip_nul.test.ts",
  "supabase/functions/_shared/__tests__/wwff.test.ts",
  // archive
  "supabase/functions/_shared/archive.ts",
  "supabase/functions/_shared/archive_convert.ts",
  "supabase/functions/_shared/archive_store.ts",
  "supabase/functions/_shared/s3.ts",
  "supabase/functions/_shared/cty.ts",
  "supabase/functions/_shared/uls.ts",
  "supabase/functions/_shared/__tests__/archive.test.ts",
  "supabase/functions/_shared/__tests__/archive_convert.test.ts",
  "supabase/functions/_shared/__tests__/archive_store.test.ts",
  "supabase/functions/_shared/__tests__/cty.test.ts",
  "supabase/functions/_shared/__tests__/s3.test.ts",
  "supabase/functions/_shared/__tests__/uls.test.ts",
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

// Part 1's bans: plain, explicit code.
const styleSyntax = [
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
];

// Part 2's bans: Zod schemas and explicit parameters.
const zodSyntax = [
  {
    selector: "CallExpression[callee.object.name='z'][callee.property.name='object']",
    message: "Use z.strictObject, not z.object.",
  },
  {
    selector: "CallExpression[callee.object.name='z'][callee.property.name=/^(any|unknown)$/]",
    message: "No z.any() or z.unknown(). Describe the real shape.",
  },
  {
    selector: "TSTypeReference[typeName.left.name='z'][typeName.right.name='infer']",
    message: "Declare the interface explicitly and annotate the schema as z.ZodType.",
  },
  {
    selector: "AssignmentPattern",
    message: "No default parameter values. Pass every argument explicitly.",
  },
  {
    selector: ":function > Identifier[optional=true]",
    message: "No optional parameters. Use T | undefined and pass undefined explicitly.",
  },
  {
    selector: "TSTypePredicate[asserts=false]",
    message: "No hand-written type guards. Validate with a Zod schema.",
  },
];

const deno = ["supabase/functions/**/*.ts", "relay/**/*.ts", "sender/**/*.ts", "scripts/**/*.ts"];

export default tseslint.config(
  { ignores: ["deno.d.ts", "node_modules/", "web/"] },
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
      "no-empty": "error",
      // The rule checks only the built-in Error classes unless it is given the names of ours.
      "preserve-caught-error": ["error", {
        errorClassNames: ["ValidationError", "FunctionCallError", "ConfigError"],
      }],
      "no-restricted-syntax": ["error", ...styleSyntax, ...zodSyntax],
    },
  },
  // Part 2 pending: the narrowing rules, the error rules and zodSyntax stay off until the area's
  // Zod schemas land.
  {
    files: zodPending,
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "no-empty": "off",
      "preserve-caught-error": "off",
      "no-restricted-syntax": ["error", ...styleSyntax],
    },
  },
  // Tests: syntax and style bans apply; fixture-typing rules do not, for good.
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
