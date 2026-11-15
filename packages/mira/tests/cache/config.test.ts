import { describe, expect, it } from "vitest"

import {
  defaultCollectionCacheConfig,
  resolveCollectionCacheConfig
} from "@/cache/index.js"

describe("collection cache config", () => {
  it("resolves an empty partial to the defaults", () => {
    expect(resolveCollectionCacheConfig({})).toEqual(defaultCollectionCacheConfig)
  })

  it("resolves a missing argument to the defaults", () => {
    expect(resolveCollectionCacheConfig()).toEqual(defaultCollectionCacheConfig)
  })

  it("merges a partial config over the defaults", () => {
    const resolved = resolveCollectionCacheConfig({ recordTtlMs: 1_000, maxLists: 3 })
    expect(resolved.recordTtlMs).toBe(1_000)
    expect(resolved.maxLists).toBe(3)
    expect(resolved.listTtlMs).toBe(defaultCollectionCacheConfig.listTtlMs)
    expect(resolved.maxRecords).toBe(defaultCollectionCacheConfig.maxRecords)
  })

  it("does not mutate the exported defaults", () => {
    resolveCollectionCacheConfig({ recordTtlMs: 1 })
    expect(defaultCollectionCacheConfig.recordTtlMs).not.toBe(1)
  })
})
