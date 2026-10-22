import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["dist/**", "node_modules/**", "src/hosted/vendor/**"] },
  {
    ...eslint.configs.recommended,
    files: [
      "src/hosted/**/*.js",
      "src/platform/**/*.js",
      "tests/server/**/*.mjs",
      "eslint.config.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["server/**/*.ts", "shared/**/*.ts", "src/hosted/**/*.ts", "scripts/**/*.ts", "build-server.ts"],
    languageOptions: {
      ...config.languageOptions,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...config.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  })),
];
