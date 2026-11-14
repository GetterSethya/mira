import { Effect, Layer } from "effect"

import { RateLimiter } from "./types.js"
import type { RateLimitIncrementResult, RateLimitStoreShape } from "./types.js"
import { makeRateLimiter, PRUNE_INTERVAL_MS, PRUNE_RETENTION_MS } from "./limiter.js"

export const makeInMemoryRateLimitStore = (): RateLimitStoreShape => {
  const buckets = new Map<string, { readonly used: number; readonly expiresAt: number }>()
  let lastPrune = 0

  const prune = (before: number) =>
    Effect.sync(() => {
      for (const [bucket, value] of buckets) {
        if (value.expiresAt <= before) buckets.delete(bucket)
      }
    })

  return {
    increment: (entries): Effect.Effect<RateLimitIncrementResult> =>
      Effect.sync(() => {
        const now = Date.now()
        if (now - lastPrune > PRUNE_INTERVAL_MS) {
          lastPrune = now
          for (const [bucket, value] of buckets) {
            if (value.expiresAt <= now - PRUNE_RETENTION_MS) buckets.delete(bucket)
          }
        }

        const current = entries.map((entry) => buckets.get(entry.bucket)?.used ?? 0)
        const blockedIndices = entries.flatMap((entry, index) =>
          (current[index] ?? 0) + entry.cost > entry.limit ? [index] : []
        )
        if (blockedIndices.length > 0) {
          return { ok: false as const, blockedIndices, counts: current }
        }

        const counts = entries.map((entry, index) => {
          const used = Math.min((current[index] ?? 0) + entry.cost, entry.limit + 1)
          const existing = buckets.get(entry.bucket)
          buckets.set(entry.bucket, {
            used,
            expiresAt: Math.max(existing?.expiresAt ?? 0, entry.expiresAt)
          })
          return used
        })
        return { ok: true as const, counts }
      }),
    prune
  }
}

export const makeInMemoryRateLimiter = () => makeRateLimiter(makeInMemoryRateLimitStore())

/**
 * Explicit in-memory limiter layer. Each layer build gets a fresh store, so two
 * apps or two tests in one process do not share buckets.
 */
export const InMemoryRateLimiterLive = Layer.effect(
  RateLimiter,
  Effect.sync(() => makeInMemoryRateLimiter())
)
