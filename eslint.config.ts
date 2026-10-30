// Plain, explicit, Go-style TypeScript for the Deno code (Edge Functions, inbound, sender, scripts).
import tseslint from "typescript-eslint";

// Part 1's bans, plus Part 2's explicit parameters.
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
  {
    selector: "AssignmentPattern",
    message: "No default parameter values. Pass every argument explicitly.",
  },
  {
    selector: ":function > Identifier[optional=true]",
    message: "No optional parameters. Use T | undefined and pass undefined explicitly.",
  },
];

// Part 2's bans: Zod schemas.
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
    selector: "TSTypePredicate[asserts=false]",
    message: "No hand-written type guards. Validate with a Zod schema.",
  },
];

const deno = ["supabase/functions/**/*.ts", "inbound/**/*.ts", "sender/**/*.ts", "scripts/**/*.ts"];

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
      // The rule checks only the built-in Error classes unless it is given the names of ours:
      // errors.ts's and the module-local ones.
      "preserve-caught-error": ["error", {
        errorClassNames: [
          "ValidationError",
          "FunctionCallError",
          "ConfigError",
          "LoggedError",
          "TimeoutError",
          "CatalogImportError",
          "ClaimError",
          "DatabaseOpenError",
          "LicenseImportError",
          "PinnedConnectError",
          "PinnedHttpError",
          "RpcAllowlistError",
          "SliceConvertError",
          "UnsafeUrlError",
          "WatchdogError",
          "ZipError",
        ],
      }],
      "no-restricted-syntax": ["error", ...styleSyntax, ...zodSyntax],
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
