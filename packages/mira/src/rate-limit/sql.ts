import { Data, Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"

import { AppConfig } from "@/config/index.js"
import { Dialect } from "@/dialect/dialect.js"
import { withStoreBootstrap } from "@/dialect/store-sql.js"

import { RateLimitStoreError } from "./errors.js"
import { makeRateLimiter, PRUNE_INTERVAL_MS, PRUNE_RETENTION_MS } from "./limiter.js"
import {
  RateLimiter,
  RateLimitKeySecret,
  RateLimitStore
} from "./types.js"
import type { RateLimitIncrementResult, RateLimitStoreShape } from "./types.js"

class RateLimitBlocked extends Data.TaggedError("RateLimitBlocked")<{
  readonly result: RateLimitIncrementResult
}> {}

export const SqlRateLimitStoreLive = Layer.effect(
  RateLimitStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dialect = yield* Dialect
    const store = dialect.store

    yield* withStoreBootstrap(sql, store, (tx) =>
      Effect.gen(function* () {
        yield* tx.unsafe(
          `CREATE TABLE IF NOT EXISTS _rate_limits (
            bucket TEXT PRIMARY KEY,
            used INTEGER NOT NULL,
            expires_at BIGINT NOT NULL
          )`
        )
        yield* tx.unsafe(
          `CREATE INDEX IF NOT EXISTS _rate_limits_expires ON _rate_limits (expires_at)`
        )
      })
    )

    let lastPrune = 0

    const prune: RateLimitStoreShape["prune"] = (before) =>
      sql`
        DELETE FROM ${sql("_rate_limits")}
        WHERE bucket IN (
          SELECT bucket FROM ${sql("_rate_limits")}
          WHERE expires_at <= ${before}
          ORDER BY bucket
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

        const buckets = entries.map((entry) => entry.bucket)
        const rows = yield* sql<{ bucket: string; used: number }>`
          SELECT bucket, used FROM ${sql("_rate_limits")}
          WHERE bucket IN ${sql.in(buckets)}
        `
        const currentByBucket = new Map(rows.map((row) => [row.bucket, Number(row.used)]))
        const current = entries.map((entry) => currentByBucket.get(entry.bucket) ?? 0)

        const preBlocked = entries.flatMap((entry, index) =>
          (current[index] ?? 0) + entry.cost > entry.limit ? [index] : []
        )
        if (preBlocked.length > 0) {
          const blocked: RateLimitIncrementResult = {
            ok: false,
            blockedIndices: preBlocked,
            counts: current
          }
          return blocked
        }

        const sorted = entries
          .map((entry, index) => ({ entry, index }))
          .sort((left, right) =>
            left.entry.bucket.localeCompare(right.entry.bucket) || left.index - right.index
          )

        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            if (store.transactionLockTimeoutSql !== undefined) {
              yield* sql.unsafe(store.transactionLockTimeoutSql)
            }

            const updated = new Map<number, number>()
            const blockedIndices: Array<number> = []

            for (const { entry, index } of sorted) {
              const result = yield* sql<{ used: number }>`
                INSERT INTO ${sql("_rate_limits")} (bucket, used, expires_at)
                SELECT ${entry.bucket}, ${entry.cost}, ${entry.expiresAt}
                WHERE CAST(${entry.cost} AS INTEGER) <= CAST(${entry.limit} AS INTEGER)
                ON CONFLICT (bucket) DO UPDATE SET
                  used = _rate_limits.used + excluded.used
                WHERE _rate_limits.used + excluded.used <= CAST(${entry.limit} AS INTEGER)
                RETURNING used
              `

              const row = result[0]
              if (row === undefined) {
                blockedIndices.push(index)
              } else {
                updated.set(index, Number(row.used))
              }
            }

            if (blockedIndices.length > 0) {
              return yield* Effect.fail(
                new RateLimitBlocked({
                  result: {
                    ok: false,
                    blockedIndices: blockedIndices.sort((left, right) => left - right),
                    counts: current
                  }
                })
              )
            }

            const counts = entries.map((_, index) => updated.get(index) ?? current[index] ?? 0)
            const incremented: RateLimitIncrementResult = { ok: true, counts }
            return incremented
          })
        ).pipe(
          Effect.retry({
            while: store.isRetryable,
            schedule: Schedule.spaced("10 millis"),
            times: 1
          })
        )

        return yield* transaction.pipe(
          Effect.catchTag("RateLimitBlocked", (error) => Effect.succeed(error.result))
        )
      }).pipe(
        Effect.mapError((error) =>
          error instanceof RateLimitStoreError
            ? error
            : new RateLimitStoreError({
                message: "Rate-limit store increment failed",
                retryable: store.isRetryable(error)
              })
        )
      )

    return { increment, prune }
  })
)

/** @deprecated Use `SqlRateLimitStoreLive`. */
export const SqliteRateLimitStoreLive = SqlRateLimitStoreLive

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
