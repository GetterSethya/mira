import { describe, expect, it } from "vitest"

import {
  installCommand,
  isPackageManager,
  PACKAGE_MANAGERS,
  type PackageManager
} from "../src/package-manager.js"

const cases: ReadonlyArray<readonly [PackageManager, string]> = [
  ["pnpm", "pnpm add @gettersethya/mira-client"],
  ["npm", "npm install @gettersethya/mira-client"],
  ["yarn", "yarn add @gettersethya/mira-client"],
  ["bun", "bun add @gettersethya/mira-client"]
]

describe("isPackageManager", () => {
  it("accepts every supported manager", () => {
    for (const manager of PACKAGE_MANAGERS) {
      expect(isPackageManager(manager)).toBe(true)
    }
  })

  it("rejects unsupported and non-string values", () => {
    expect(isPackageManager("deno")).toBe(false)
    expect(isPackageManager("")).toBe(false)
    expect(isPackageManager(null)).toBe(false)
    expect(isPackageManager(undefined)).toBe(false)
    expect(isPackageManager(1)).toBe(false)
  })
})

describe("installCommand", () => {
  it("uses each manager's install subcommand", () => {
    for (const [manager, expected] of cases) {
      expect(installCommand(manager, ["@gettersethya/mira-client"])).toBe(expected)
    }
  })

  it("joins multiple packages in order", () => {
    expect(
      installCommand("npm", [
        "@gettersethya/mira-tanstack-adapter",
        "@tanstack/svelte-query"
      ])
    ).toBe("npm install @gettersethya/mira-tanstack-adapter @tanstack/svelte-query")
  })
})
