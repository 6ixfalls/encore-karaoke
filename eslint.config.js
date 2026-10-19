import eslint from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    ...eslint.configs.recommended,
    files: [
      "server/**/*.mjs",
      "shared/**/*.js",
      "src/hosted/**/*.js",
      "src/platform/**/*.js",
      "tests/server/**/*.mjs",
      "build-server.mjs",
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
];
