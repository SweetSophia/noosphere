import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "openclaw-noosphere-memory/dist/**",
    "noosphere-injected-memory/dist/**",
    "next-env.d.ts",
  ]),
  // Route authorization must work for both API keys and human sessions.
  {
    files: ["src/app/api/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        // Conservative policy: route modules may not read statically named
        // role fields or destructure them from ANY value. This also rejects
        // aliases without pretending a syntax selector proves data-flow auth.
        // Human-session logic outside routes is unaffected; the two legitimate
        // route policy exceptions remain individually line-scoped.
        {
          selector: "MemberExpression[computed=false][property.name='role']",
          message: "Use hasPermission/requirePermission; route role access can exclude API keys.",
        },
        {
          selector: "MemberExpression[computed=true][property.value='role']",
          message: "Use hasPermission/requirePermission; route role access can exclude API keys.",
        },
        {
          selector: ":matches(MemberExpression[computed=true], ObjectPattern > Property[computed=true]) > :matches(TSAsExpression, TSTypeAssertion, TSNonNullExpression, TSSatisfiesExpression) Literal[value='role']",
          message: "Use shared permissions, not a role key hidden behind a TypeScript wrapper.",
        },
        {
          selector: ":matches(MemberExpression[computed=true], ObjectPattern > Property[computed=true]) TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked='role']",
          message: "Use shared permissions, not a static role template key.",
        },
        {
          selector: "ObjectPattern > Property[key.name='role'], ObjectPattern > Property[key.value='role']",
          message: "Do not extract role in API routes; use hasPermission/requirePermission.",
        },
      ],
    },
  },
  // Allow underscore-prefixed variables to be unused in test files (intentional discard pattern)
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
