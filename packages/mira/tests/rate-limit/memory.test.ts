import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, expect, vi } from "vitest"

import {
  makeInMemoryRateLimitStore,
  makeRateLimiter,
  RateLimitStoreError
} from "@/rate-limit/index.js"
import type { RateLimitPolicy, RateLimitStoreShape } from "@/rate-limit/index.js"

const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  name: "test:policy",
  limit: 2,
  windowMs: 60_000,
  onStoreError: "allow",
  ...overrides
})

describe("in-memory rate-limit store", () => {
  afterEach(() => vi.restoreAllMocks())

  it.effect("increments until the limit and then blocks without changing used", () =>
    Effect.gen(function* () {
      const store = makeInMemoryRateLimitStore()
      const entry = { bucket: "a", limit: 2, cost: 1, expiresAt: 1000 }
      const one = yield* store.increment([entry])
      const two = yield* store.increment([entry])
      const three = yield* store.increment([entry])
      expect(one).toEqual({ ok: true, counts: [1] })
      expect(two).toEqual({ ok: true, counts: [2] })
      expect(three).toEqual({ ok: false, blockedIndices: [0], counts: [2] })
    })
  )

  it.effect("is all-or-nothing across buckets", () =>
    Effect.gen(function* () {
      const store = makeInMemoryRateLimitStore()
      const a = { bucket: "a", limit: 2, cost: 1, expiresAt: 1000 }
      const b = { bucket: "b", limit: 1, cost: 1, expiresAt: 1000 }
      yield* store.increment([a])
      yield* store.increment([b])
      const blocked = yield* store.increment([a, b])
      expect(blocked).toEqual({ ok: false, blockedIndices: [1], counts: [1, 1] })
      const after = yield* store.increment([a])
      expect(after).toEqual({ ok: true, counts: [2] })
    })
  )

  it.effect("prunes only expired buckets", () =>
    Effect.gen(function* () {
      const store = makeInMemoryRateLimitStore()
      yield* store.increment([
        { bucket: "old", limit: 1, cost: 1, expiresAt: 100 },
        { bucket: "new", limit: 1, cost: 1, expiresAt: 500 }
      ])
      yield* store.prune(200)
      const old = yield* store.increment([{ bucket: "old", limit: 1, cost: 1, expiresAt: 100 }])
      const fresh = yield* store.increment([{ bucket: "new", limit: 1, cost: 1, expiresAt: 500 }])
      expect(old).toEqual({ ok: true, counts: [1] })
      expect(fresh).toEqual({ ok: false, blockedIndices: [0], counts: [1] })
    })
  )

  it.effect("computes resetAt and retryAfter from the fixed window", () =>
    Effect.gen(function* () {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
      const limiter = makeRateLimiter(makeInMemoryRateLimitStore())
      const p = policy({ limit: 1, windowMs: 60_000 })
      const first = yield* limiter.consume(p, "key")
      const second = yield* limiter.consume(p, "key")
      expect(first.blocked).toBeNull()
      expect(second.blocked?.retryAfterSeconds).toBe(20)
      expect(second.blocked?.resetAt).toBe(1_020_000)

      now.mockReturnValue(1_020_000)
      const next = yield* limiter.consume(p, "key")
      expect(next.blocked).toBeNull()
      expect(next.decisions[0]?.used).toBe(1)
    })
  )

  it.effect("reports the longest wait among blocked policies", () =>
    Effect.gen(function* () {
      vi.spyOn(Date, "now").mockReturnValue(1_000_000)
      const limiter = makeRateLimiter(makeInMemoryRateLimitStore())
      const hourly = policy({ name: "hourly", limit: 1, windowMs: 60_000, onStoreError: "deny" })
      const daily = policy({ name: "daily", limit: 1, windowMs: 86_400_000, onStoreError: "deny" })
      const first = yield* limiter.consumeMany([
        { policy: hourly, key: "key" },
        { policy: daily, key: "key" }
      ])
      const second = yield* limiter.consumeMany([
        { policy: hourly, key: "key" },
        { policy: daily, key: "key" }
      ])
      expect(first.blocked).toBeNull()
      expect(second.blocked?.policy).toBe("daily")
      expect(second.blocked?.retryAfterSeconds).toBeGreaterThan(60)
    })
  )

  it.effect("rejects non-positive and fractional costs", () =>
    Effect.gen(function* () {
      const limiter = makeRateLimiter(makeInMemoryRateLimitStore())
      for (const cost of [0, -1, 1.5, Number.NaN]) {
        const exit = yield* limiter.consume(policy(), "key", cost).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }
    })
  )

  it.effect("fails open for allow policies and closed for deny policies", () =>
    Effect.gen(function* () {
      const failing: RateLimitStoreShape = {
        increment: () =>
          Effect.fail(new RateLimitStoreError({ message: "down", retryable: true })),
        prune: () => Effect.void
      }
      const limiter = makeRateLimiter(failing)
      const allowed = yield* limiter.consume(policy({ onStoreError: "allow" }), "key")
      expect(allowed.blocked).toBeNull()
      expect(allowed.decisions[0]?.degraded).toBe(true)

      const denied = yield* limiter
        .consume(policy({ onStoreError: "deny" }), "key")
        .pipe(Effect.exit)
      expect(denied._tag).toBe("Failure")
    })
  )
})
