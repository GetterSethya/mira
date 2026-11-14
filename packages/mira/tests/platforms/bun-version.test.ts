import { describe, it } from "@effect/vitest"
import { expect } from "vitest"

import { isSupportedBunVersion, MINIMUM_BUN_VERSION } from "@/platforms/bun-version.js"

describe("isSupportedBunVersion", () => {
  it("accepts the minimum and newer releases", () => {
    expect(MINIMUM_BUN_VERSION).toBe("1.3.14")
    expect(isSupportedBunVersion("1.3.14")).toBe(true)
    expect(isSupportedBunVersion("1.3.15")).toBe(true)
    expect(isSupportedBunVersion("1.4.2")).toBe(true)
    expect(isSupportedBunVersion("1.10.0")).toBe(true)
    expect(isSupportedBunVersion("2.0.0")).toBe(true)
  })

  it("rejects older releases", () => {
    expect(isSupportedBunVersion("1.3.13")).toBe(false)
    expect(isSupportedBunVersion("1.2.99")).toBe(false)
    expect(isSupportedBunVersion("0.8.0")).toBe(false)
  })

  it("handles prerelease suffixes by numeric prefix", () => {
    expect(isSupportedBunVersion("1.3.14-canary.1")).toBe(true)
    expect(isSupportedBunVersion("1.3.13-canary.9")).toBe(false)
  })

  it("rejects malformed versions", () => {
    expect(isSupportedBunVersion("")).toBe(false)
    expect(isSupportedBunVersion("canary")).toBe(false)
  })
})
