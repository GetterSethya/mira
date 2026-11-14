import { Effect, Layer } from "effect"
import type { SqlError } from "effect/sql"
import { SqlClient } from "effect/sql"

import { AppConfig } from "@/config/index.js"

import { RateLimitStoreError } from "./errors.js"
import { makeRateLimiter, PRUNE_INTERVAL_MS, PRUNE_RETENTION_MS } from "./limiter.js"
import {
  RateLimiter,
  RateLimitKeySecret,
  RateLimitStore
} from "./types.js"
import type { RateLimitIncrementResult, RateLimitStoreShape } from "./types.js"

const isRetryable = (error: SqlError.SqlError) =>
  /SQLITE_(BUSY|LOCKED)/i.test(error.message)

export const SqliteRateLimitStoreLive = Layer.effect(
  RateLimitStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql.unsafe(
      `CREATE TABLE IF NOT EXISTS _rate_limits (
        bucket TEXT PRIMARY KEY,
        used INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`
    )
    yield* sql.unsafe(
      `CREATE INDEX IF NOT EXISTS _rate_limits_expires ON _rate_limits (expires_at)`
    )

    let lastPrune = 0

    const prune: RateLimitStoreShape["prune"] = (before) =>
      sql`
        DELETE FROM ${sql("_rate_limits")}
        WHERE bucket IN (
          SELECT bucket FROM ${sql("_rate_limits")}
          WHERE expires_at <= ${before}
          LIMIT 1000
        )
      `.pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning("rate_limit.prune_failed", { message: error.message })
        )
      )

    const increment: RateLimitStoreShape["increment"] = (entries) =>
      Effect.gen(function* () {
        if (entries.length === 0) {
          return { ok: true as const, counts: [] }
        }

        const now = Date.now()
        if (now - lastPrune > PRUNE_INTERVAL_MS) {
          lastPrune = now
          yield* prune(now - PRUNE_RETENTION_MS).pipe(Effect.catch(() => Effect.void))
        }

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const current: Array<number> = []
            for (const entry of entries) {
              const rows = yield* sql<{ used: number }>`
                SELECT used FROM ${sql("_rate_limits")} WHERE bucket = ${entry.bucket}
              `
              current.push(Number(rows[0]?.used ?? 0))
            }

            const blockedIndices = entries.flatMap((entry, index) =>
              (current[index] ?? 0) + entry.cost > entry.limit ? [index] : []
            )
            if (blockedIndices.length > 0) {
              const blocked: RateLimitIncrementResult = {
                ok: false,
                blockedIndices,
                counts: current
              }
              return blocked
            }

            const counts: Array<number> = []
            for (const entry of entries) {
              const rows = yield* sql<{ used: number }>`
                INSERT INTO ${sql("_rate_limits")} (bucket, used, expires_at)
                VALUES (${entry.bucket}, ${entry.cost}, ${entry.expiresAt})
                ON CONFLICT(bucket) DO UPDATE SET used = MIN(used + ${entry.cost}, ${entry.limit + 1})
                RETURNING used
              `
              counts.push(Number(rows[0]?.used ?? 0))
            }

            const incremented: RateLimitIncrementResult = { ok: true, counts }
            return incremented
          })
        )
      }).pipe(
        Effect.mapError(
          (error: SqlError.SqlError) =>
            new RateLimitStoreError({
              message: "Rate-limit store increment failed",
              retryable: isRetryable(error)
            })
        )
      )

    return { increment, prune }
  })
)

export const RateLimiterLive = Layer.effect(
  RateLimiter,
  Effect.gen(function* () {
    const store = yield* RateLimitStore
    return makeRateLimiter(store)
  })
)

export const RateLimitKeySecretLive = Layer.effect(
  RateLimitKeySecret,
  Effect.map(AppConfig, (config) => config.jwtSecret)
)
