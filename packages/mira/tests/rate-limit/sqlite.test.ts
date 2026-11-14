import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import { RateLimitStore } from "@/rate-limit/index.js"
import { SqliteRateLimitStoreLive } from "@/rate-limit/sqlite.js"
import type { RateLimitEntry } from "@/rate-limit/index.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const storeLayer = SqliteRateLimitStoreLive.pipe(Layer.provide(sqliteLayer))

const entry = (bucket: string, limit: number, expiresAt = 1_000): RateLimitEntry => ({
  bucket,
  limit,
  cost: 1,
  expiresAt
})

describe("SQLite rate-limit store", () => {
  it.effect("is all-or-nothing across buckets", () =>
    Effect.gen(function* () {
      const store = yield* RateLimitStore
      yield* store.increment([entry("a", 2), entry("b", 1)])
      const blocked = yield* store.increment([entry("a", 2), entry("b", 1)])
      expect(blocked).toEqual({ ok: false, blockedIndices: [1], counts: [1, 1] })
      const a = yield* store.increment([entry("a", 2)])
      expect(a).toEqual({ ok: true, counts: [2] })
    }).pipe(Effect.provide(storeLayer))
  )

  it.effect("does not lose concurrent increments", () =>
    Effect.gen(function* () {
      const store = yield* RateLimitStore
      const results = yield* Effect.all(
        Array.from({ length: 20 }, () => store.increment([entry("race", 10)])),
        { concurrency: "unbounded" }
      )
      const allowed = results.filter((result) => result.ok).length
      const final = yield* store.increment([entry("race", 10)])
      expect(allowed).toBe(10)
      expect(final).toEqual({ ok: false, blockedIndices: [0], counts: [10] })
    }).pipe(Effect.provide(storeLayer))
  )

  it.effect("prunes only rows older than the cutoff", () =>
    Effect.gen(function* () {
      const store = yield* RateLimitStore
      yield* store.increment([entry("old", 1, 100), entry("new", 1, 500)])
      yield* store.prune(200)
      const old = yield* store.increment([entry("old", 1, 100)])
      const fresh = yield* store.increment([entry("new", 1, 500)])
      expect(old).toEqual({ ok: true, counts: [1] })
      expect(fresh).toEqual({ ok: false, blockedIndices: [0], counts: [1] })
    }).pipe(Effect.provide(storeLayer))
  )
})
