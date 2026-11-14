import { Effect } from "effect"

import { RateLimitUnavailableError } from "./errors.js"
import type {
  RateLimitBatchResult,
  RateLimitDecision,
  RateLimitEntry,
  RateLimitRequest,
  RateLimiterShape,
  RateLimitStoreShape
} from "./types.js"

export const PRUNE_INTERVAL_MS = 60_000
export const PRUNE_RETENTION_MS = 5 * 60_000

const scopeForPolicy = (policy: string): "request" | "send" | "cooldown" => {
  if (policy.includes("cooldown")) return "cooldown"
  if (policy.includes(":send:")) return "send"
  return "request"
}

const windowFor = (windowMs: number, now: number) => Math.floor(now / windowMs) * windowMs

const decisionFor = (
  policy: string,
  limit: number,
  used: number,
  expiresAt: number,
  now: number,
  allowed: boolean,
  degraded: boolean
): RateLimitDecision => ({
  allowed,
  policy,
  used,
  limit,
  remaining: Math.max(0, limit - used),
  resetAt: expiresAt,
  retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((expiresAt - now) / 1000)),
  degraded
})

const logThreshold = (decision: RateLimitDecision) => {
  if (!decision.allowed || decision.degraded || decision.limit < 5) return Effect.void
  const eighty = Math.floor(decision.limit * 0.8)
  if (decision.used !== decision.limit && decision.used !== eighty) return Effect.void
  return Effect.logWarning("rate_limit.threshold", {
    policy: decision.policy,
    used: decision.used,
    limit: decision.limit,
    level: decision.used === decision.limit ? "limit" : "80"
  })
}

export const makeRateLimiter = (store: RateLimitStoreShape): RateLimiterShape => {
  const consumeMany = (
    requests: ReadonlyArray<RateLimitRequest>
  ): Effect.Effect<RateLimitBatchResult, RateLimitUnavailableError> =>
    Effect.gen(function* () {
      if (requests.length === 0) return { decisions: [], blocked: null }

      const first = requests[0]
      if (first === undefined) return { decisions: [], blocked: null }
      const mode = first.policy.onStoreError
      if (requests.some((request) => request.policy.onStoreError !== mode)) {
        return yield* Effect.fail(
          new RateLimitUnavailableError({
            message: "A rate-limit batch mixed allow and deny store-error policies"
          })
        )
      }

      const now = Date.now()
      const entries: Array<RateLimitEntry> = []
      for (const request of requests) {
        const cost = request.cost ?? 1
        if (!Number.isInteger(cost) || cost < 1) {
          return yield* Effect.fail(
            new RateLimitUnavailableError({ message: "Rate-limit cost must be a positive integer" })
          )
        }
        const windowStart = windowFor(request.policy.windowMs, now)
        entries.push({
          bucket: JSON.stringify([request.policy.name, request.key, windowStart]),
          limit: request.policy.limit,
          cost,
          expiresAt: windowStart + request.policy.windowMs
        })
      }

      const result = yield* store.increment(entries).pipe(
        Effect.catch((error) => {
          if (mode === "allow") {
            return Effect.logWarning("rate_limit.store_failed", {
              policy: first.policy.name,
              message: error.message,
              retryable: error.retryable
            }).pipe(Effect.as(null))
          }
          return Effect.logError("rate_limit.store_failed", {
            policy: first.policy.name,
            message: error.message,
            retryable: error.retryable
          }).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new RateLimitUnavailableError({ message: "The rate-limit store is unavailable" })
              )
            )
          )
        })
      )

      if (result === null) {
        const decisions = requests.map((request) =>
          decisionFor(
            request.policy.name,
            request.policy.limit,
            0,
            windowFor(request.policy.windowMs, now) + request.policy.windowMs,
            now,
            true,
            true
          )
        )
        return { decisions, blocked: null }
      }

      const decisions = requests.map((request, index) => {
        const entry = entries[index]!
        const used = result.counts[index] ?? 0
        const allowed = result.ok || !result.blockedIndices.includes(index)
        return decisionFor(
          request.policy.name,
          request.policy.limit,
          used,
          entry.expiresAt,
          now,
          allowed,
          false
        )
      })

      yield* Effect.forEach(decisions, logThreshold).pipe(Effect.asVoid)

      const blocked = result.ok
        ? null
        : result.blockedIndices
            .map((index) => decisions[index])
            .filter((decision): decision is RateLimitDecision => decision !== undefined)
            .reduce<RateLimitDecision | null>(
              (longest, decision) =>
                longest === null || decision.retryAfterSeconds > longest.retryAfterSeconds
                  ? decision
                  : longest,
              null
            )
      if (blocked !== null) {
        yield* Effect.logWarning("rate_limit.blocked", {
          policy: blocked.policy,
          scope: scopeForPolicy(blocked.policy),
          used: blocked.used,
          limit: blocked.limit,
          retryAfterSeconds: blocked.retryAfterSeconds
        })
      }

      return { decisions, blocked }
    })

  return {
    consume: (policy, key, cost) =>
      consumeMany([{ policy, key, ...(cost === undefined ? {} : { cost }) }]),
    consumeMany
  }
}
