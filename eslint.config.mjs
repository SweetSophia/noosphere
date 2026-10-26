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
        {
          selector: "BinaryExpression > MemberExpression[object.name='auth'][property.name='role']",
          message: "Use hasPermission/requirePermission; auth.role is absent for API keys.",
        },
        {
          selector: "BinaryExpression > MemberExpression[object.name='auth'][computed=true][property.value='role']",
          message: "Use hasPermission/requirePermission; auth.role is absent for API keys.",
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
