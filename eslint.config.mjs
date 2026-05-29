import js from "@eslint/js"
import tseslint from "typescript-eslint"
import simpleImportSort from "eslint-plugin-simple-import-sort"
import sortDestructureKeys from "eslint-plugin-sort-destructure-keys"

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "*.tsbuildinfo", "coverage"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
      "sort-destructure-keys": sortDestructureKeys
    },
    rules: {
      "object-shorthand": "error",
      "no-unused-vars": "off",
      "no-fallthrough": "off",

      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "sort-destructure-keys/sort-destructure-keys": "error",

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-namespace": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-wrapper-object-types": "off",
      "@typescript-eslint/array-type": [
        "warn",
        {
          default: "generic",
          readonly: "generic"
        }
      ]
    }
  }
)
