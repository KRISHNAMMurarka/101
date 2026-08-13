import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import next from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    // Packaged output from `npm run package:release`, plus generated native projects. These are
    // build products, not sources; linting them reports on bundlers rather than on this codebase.
    "release/**",
    "apps/controller-native/android/**",
    "apps/controller-native/ios/**",
    "apps/watch-wear/**/build/**",
    "public/mediapipe/**",
    "apps/controller-native/metro.config.cjs",
    "apps/desktop-hub/dist/**",
    "apps/desktop-hub/src-tauri/target/**",
    "apps/desktop-hub/src-tauri/gen/**",
    "next-env.d.ts",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  next.configs["core-web-vitals"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
]);

export default eslintConfig;
