import { fixupPluginRules } from "@eslint/compat";
import eslint from "@eslint/js";
import prettierExtends from "eslint-config-prettier";
import eslintCommentsPlugin from "eslint-plugin-eslint-comments";
import importPlugin from "eslint-plugin-import";
import prettierPlugin from "eslint-plugin-prettier";
import promisePlugin from "eslint-plugin-promise";
import reactPlugin from "eslint-plugin-react";
import reactCompilerPlugin from "eslint-plugin-react-compiler";
import hooksPlugin from "eslint-plugin-react-hooks";
import reactNativePlugin from "eslint-plugin-react-native";
import unusedImportsPlugin from "eslint-plugin-unused-imports";
import { globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const globalToUse = {
  ...globals.browser,
  ...globals.serviceworker,
  ...globals.es2021,
  ...globals.worker,
  ...globals.node,
  React: true,
};

const ignores = [
  ".claude/**/*",
  ".cursor/**/*",
  ".expo/**/*",
  ".yarn/**/*",
  ".idea/**/*",
  "node_modules/**/*",
  "android/**/*",
  "ios/**/*",
  "metro.config.cjs",
  "metro.config.js",
  "babel.config.js",
  "eslint.config.mjs",
  "uniwind.d.ts",
  "uniwind-types.d.ts",
  "android/**/*",
];

const rules = {
  "react-compiler/react-compiler": "error",
  "react-hooks/exhaustive-deps": "error",
  "react-hooks/rules-of-hooks": "error",
  "no-prototype-builtins": "error",
  "@typescript-eslint/no-use-before-define": "off",
  "prefer-const": "error",
  "promise/no-callback-in-promise": "off",
  curly: ["error", "all"],
  "@typescript-eslint/no-non-null-assertion": "off",
  "no-empty": "error",
  "no-bitwise": "off",
  "no-case-declarations": "off",
  "no-constant-binary-expression": "error",
  "no-constant-condition": "error",
  "@typescript-eslint/no-unused-expressions": "error",
  "no-control-regex": "off",
  "promise/always-return": "off",
  "promise/catch-or-return": "error",
  // "no-restricted-exports": ["error", { restrictDefaultExports: { direct: true } }],
  "@typescript-eslint/no-namespace": "off",
  "@typescript-eslint/no-empty-interface": "error",
  "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
  "@typescript-eslint/consistent-type-imports": [
    "error",
    {
      fixStyle: "inline-type-imports",
      prefer: "type-imports",
    },
  ],
  "@typescript-eslint/consistent-type-exports": [
    "error",
    {
      fixMixedExportsWithInlineTypeSpecifier: true,
    },
  ],
  "@typescript-eslint/ban-ts-comment": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-import-type-side-effects": "error",
  "react/jsx-curly-brace-presence": ["error", { props: "always", children: "ignore", propElementValues: "always" }],
  "unused-imports/no-unused-imports": "error",
  "object-shorthand": "error",
  "no-async-promise-executor": "off",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { varsIgnorePattern: "^_", argsIgnorePattern: "^_", ignoreRestSiblings: true },
  ],
  quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
  "prettier/prettier": "error",
};
/** @type {import('@typescript-eslint/utils').FlatConfig.Config} */
const eslintReactNativeRules = {
  ignores,
  files: ["**/*.{ts,tsx,js,jsx}"],
  languageOptions: {
    // Map from global var to bool specifying if it can be redefined
    globals: {
      __DEV__: true,
      __dirname: false,
      __fbBatchedBridgeConfig: false,
      AbortController: false,
      Blob: true,
      alert: false,
      cancelAnimationFrame: false,
      cancelIdleCallback: false,
      clearImmediate: true,
      clearInterval: false,
      clearTimeout: false,
      console: false,
      document: false,
      ErrorUtils: false,
      escape: false,
      Event: false,
      EventTarget: false,
      exports: false,
      fetch: false,
      File: true,
      FileReader: false,
      FormData: false,
      global: false,
      Headers: false,
      Intl: false,
      Map: true,
      module: false,
      navigator: false,
      process: false,
      Promise: true,
      requestAnimationFrame: true,
      requestIdleCallback: true,
      require: false,
      Set: true,
      setImmediate: true,
      setInterval: false,
      setTimeout: false,
      queueMicrotask: true,
      URL: false,
      URLSearchParams: false,
      WebSocket: true,
      window: false,
      XMLHttpRequest: false,
    },
  },
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            // Disallow src (~/) imports
            regex: "~/(?!(shared/|styles/)).*",
          },
          {
            // Disallow job imports
            regex: "-/.*",
          },
          {
            // Disallow public imports that aren't locales
            regex: "~/pub/(?!(locales/)).*",
          },
        ],
      },
    ],
    "react-native/no-inline-styles": "off",
    "react/no-unstable-nested-components": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      },
    ],
    "no-unused-vars": "off",
    ...rules,
  },
};

for (const key of Object.keys(eslintReactNativeRules.rules)) {
  if (key.startsWith("jest")) {
    delete eslintReactNativeRules.rules[key];
  }
}

const configs = tseslint.config(
  {
    plugins: {
      promise: promisePlugin,
      prettier: prettierPlugin,
      "unused-imports": fixupPluginRules(unusedImportsPlugin),
      react: reactPlugin,
      "react-hooks": fixupPluginRules(hooksPlugin),
      "react-compiler": reactCompilerPlugin,
      "eslint-comments": fixupPluginRules(eslintCommentsPlugin),
      "react-native": fixupPluginRules(reactNativePlugin),
      import: fixupPluginRules(importPlugin),
    },
  },
  {
    ignores,
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      promisePlugin.configs["flat/recommended"],
      prettierExtends,
    ],

    rules: rules,
    settings: {
      react: { version: "detect" },
    },
  },
  eslintReactNativeRules,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globalToUse,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
  },
  { ignores },
  globalIgnores([".yarn/", ".expo/", ".idea/", "android/", "ios/"]),
);

export default configs;
