import { Data, Effect, Layer, Predicate, Schedule } from "effect"
import { SqlClient } from "effect/sql"

import { AppConfig } from "@/config/index.js"
import { Dialect } from "@/dialect/dialect.js"
import { ensureStoreIndex, withStoreBootstrap } from "@/dialect/store-sql.js"
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
    const quote = dialect.quoteIdentifier

    yield* withStoreBootstrap(sql, store, (tx) =>
      Effect.gen(function* () {
        yield* tx.unsafe(
          `CREATE TABLE IF NOT EXISTS ${quote("_rate_limits")} (
            ${quote("bucket")} ${store.bucketColumnType} PRIMARY KEY,
            ${quote("used")} INTEGER NOT NULL,
            ${quote("expires_at")} BIGINT NOT NULL
          )`
        )
        yield* ensureStoreIndex(
          tx,
          store,
          store.createIndexIfNotExists(
            "_rate_limits_expires",
            "_rate_limits",
            ["expires_at"],
            false
          )
        )
      })
    )

    let lastPrune = 0

    const prune: RateLimitStoreShape["prune"] = (before) =>
      sql`
        DELETE FROM ${sql("_rate_limits")}
        WHERE ${sql("bucket")} IN (
          SELECT ${sql("doomed")}.${sql("bucket")} FROM (
            SELECT ${sql("bucket")} FROM ${sql("_rate_limits")}
            WHERE ${sql("expires_at")} <= ${before}
            ORDER BY ${sql("bucket")}
            LIMIT 1000
          ) AS ${sql("doomed")}
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

        for (const entry of entries) {
          if ([...entry.bucket].length > store.bucketMaxLength) {
            return yield* Effect.fail(
              new RateLimitStoreError({
                message: `Rate-limit bucket exceeds ${store.bucketMaxLength} characters`,
                retryable: false
              })
            )
          }
        }

        const now = Date.now()
        if (now - lastPrune > PRUNE_INTERVAL_MS) {
          lastPrune = now
          yield* prune(now - PRUNE_RETENTION_MS).pipe(Effect.catch(() => Effect.void))
        }

        const buckets = entries.map((entry) => entry.bucket)
        const sorted = entries
          .map((entry, index) => ({ entry, index }))
          .sort((left, right) =>
            left.entry.bucket.localeCompare(right.entry.bucket) || left.index - right.index
          )

        if (store.mutationResult._tag === "returning") {
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
        }

        // MySQL and MariaDB: no guarded upsert with RETURNING. Lock the batch,
        // evaluate the guard in memory, write, and fail the transaction when
        // any entry blocks so every earlier write rolls back.
        const transaction = sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ bucket: string; used: number }>`
              SELECT bucket, used FROM ${sql("_rate_limits")}
              WHERE bucket IN ${sql.in(buckets)}
            `
            const initialUsed = new Map(
              existing.map((row) => [row.bucket, Number(row.used)])
            )
            const usedByBucket = new Map(initialUsed)
            const updated = new Map<number, number>()
            const blockedIndices: Array<number> = []

            for (const { entry, index } of sorted) {
              let current = usedByBucket.get(entry.bucket)
              if (current !== undefined) {
                const locked = yield* sql<{ used: number }>`
                  SELECT used FROM ${sql("_rate_limits")}
                  WHERE bucket = ${entry.bucket}
                  FOR UPDATE
                `
                const lockedRow = locked[0]
                if (lockedRow === undefined) {
                  current = undefined
                } else {
                  current = Number(lockedRow.used)
                  usedByBucket.set(entry.bucket, current)
                }
              }

              const used = current ?? 0
              if (used + entry.cost > entry.limit) {
                blockedIndices.push(index)
                continue
              }

              if (current !== undefined) {
                yield* sql`
                  UPDATE ${sql("_rate_limits")}
                  SET used = used + ${entry.cost}
                  WHERE bucket = ${entry.bucket}
                `
              } else {
                yield* sql`
                  INSERT INTO ${sql("_rate_limits")} (bucket, used, expires_at)
                  VALUES (${entry.bucket}, ${entry.cost}, ${entry.expiresAt})
                `
              }

              usedByBucket.set(entry.bucket, used + entry.cost)
              updated.set(index, used + entry.cost)
            }

            if (blockedIndices.length > 0) {
              return yield* Effect.fail(
                new RateLimitBlocked({
                  result: {
                    ok: false,
                    blockedIndices: blockedIndices.sort((left, right) => left - right),
                    counts: entries.map(
                      (entry) => initialUsed.get(entry.bucket) ?? 0
                    )
                  }
                })
              )
            }

            return {
              ok: true as const,
              counts: entries.map((_, index) => updated.get(index) ?? 0)
            }
          })
        ).pipe(
          Effect.retry({
            while: (error) =>
              store.isRetryable(error) || store.isDuplicateKey(error),
            schedule: Schedule.exponential("5 millis").pipe(Schedule.jittered),
            times: 1
          })
        )

        return yield* transaction.pipe(
          Effect.catchTag("RateLimitBlocked", (error) => Effect.succeed(error.result))
        )
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("rate_limit.increment_failed", {
            error: String(error)
          })
        ),
        Effect.mapError((error) =>
          Predicate.isTagged(error, "RateLimitStoreError")
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


