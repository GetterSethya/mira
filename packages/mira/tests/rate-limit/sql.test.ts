import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { RateLimitStore } from "@/rate-limit/index.js"
import { SqlRateLimitStoreLive } from "@/rate-limit/sql.js"
import type { RateLimitEntry } from "@/rate-limit/index.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const dialectLayer = Layer.succeed(Dialect, sqliteDialect)
const storeLayer = SqlRateLimitStoreLive.pipe(Layer.provide(Layer.mergeAll(sqliteLayer, dialectLayer)))

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

  it.effect("returns complete blocked indices and pre-state counts, and leaves blocked entries unwritten", () =>
    Effect.gen(function* () {
      const store = yield* RateLimitStore
      yield* store.increment([entry("a", 2), entry("b", 2), entry("c", 2)])
      const blocked = yield* store.increment([entry("a", 1), entry("b", 2), entry("c", 1)])
      expect(blocked).toEqual({
        ok: false,
        blockedIndices: [0, 2],
        counts: [1, 1, 1]
      })
      const b = yield* store.increment([entry("b", 2)])
      expect(b).toEqual({ ok: true, counts: [2] })
    }).pipe(Effect.provide(storeLayer))
  )

  it.effect("applies duplicate buckets in order and blocks a limit-1 pair", () =>
    Effect.gen(function* () {
      const store = yield* RateLimitStore
      const allowed = yield* store.increment([entry("d", 2), entry("d", 2)])
      expect(allowed).toEqual({ ok: true, counts: [1, 2] })

      const blocked = yield* store.increment([entry("e", 1), entry("e", 1)])
      expect(blocked).toEqual({ ok: false, blockedIndices: [1], counts: [0, 0] })

      const after = yield* store.increment([entry("e", 1)])
      expect(after).toEqual({ ok: true, counts: [1] })
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
