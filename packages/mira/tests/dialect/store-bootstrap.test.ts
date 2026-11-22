import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { expect } from "vitest"

import { AuthChallengeStore, AuthChallengeStoreLive } from "@/auth/index.js"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { CronService, makeCronServiceLayer } from "@/cron/cron-service.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import type { DialectType, StoreSqlCapabilities } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import { TokenStore, TokenStoreLive } from "@/http/token-store.js"
import { RateLimitStore } from "@/rate-limit/index.js"
import { SqlRateLimitStoreLive } from "@/rate-limit/sql.js"

const transactionalStore: StoreSqlCapabilities = {
  bootstrapMode: "transaction",
  bootstrapSql: ["SELECT 1"],
  columnExistsSql: sqliteDialect.store.columnExistsSql,
  isRetryable: sqliteDialect.store.isRetryable,
  isDuplicateKey: sqliteDialect.store.isDuplicateKey
}

const transactionalDialect: DialectType = {
  ...sqliteDialect,
  store: transactionalStore
}

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const dialectLayer = Layer.succeed(Dialect, transactionalDialect)
const databaseLayer = Layer.mergeAll(sqliteLayer, dialectLayer)

describe("transaction-mode store bootstrap", () => {
  it.effect("builds the auth challenge store", () =>
    Effect.gen(function* () {
      const store = yield* AuthChallengeStore
      const now = Date.now()
      yield* store.create({
        id: "tx-challenge",
        collection: "users",
        userId: "user-1",
        purpose: "login_otp",
        tokenHash: "hash-tx",
        expiresAt: now + 60_000,
        consumedAt: null,
        attempts: 0,
        createdAt: now,
        newEmail: null
      })
      expect(yield* store.findById("users", "tx-challenge", "login_otp")).toBeDefined()
    }).pipe(
      Effect.provide(AuthChallengeStoreLive.pipe(Layer.provide(databaseLayer)))
    )
  )

  it.effect("builds the token store", () =>
    Effect.gen(function* () {
      const store = yield* TokenStore
      yield* store.revoke("tx-jti", Date.now() + 60_000)
      expect(yield* store.isRevoked("tx-jti")).toBe(true)
    }).pipe(Effect.provide(TokenStoreLive.pipe(Layer.provide(databaseLayer))))
  )

  it.effect("builds the rate-limit store", () =>
    Effect.gen(function* () {
      const store = yield* RateLimitStore
      const result = yield* store.increment([
        { bucket: "tx-bucket", limit: 2, cost: 1, expiresAt: Date.now() + 60_000 }
      ])
      expect(result).toEqual({ ok: true, counts: [1] })
    }).pipe(Effect.provide(SqlRateLimitStoreLive.pipe(Layer.provide(databaseLayer))))
  )

  it.effect("builds the config layer", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(config.appName).toBe("mira")
    }).pipe(
      Effect.provide(
        AppConfigLive.pipe(Layer.provide(databaseLayer), Layer.provide(NodeCryptoLayer))
      )
    )
  )

  it.effect("builds the cron layer", () =>
    Effect.gen(function* () {
      const cron = yield* CronService
      expect((yield* cron.getAll()).length).toBe(1)
    }).pipe(
      Effect.provide(
        makeCronServiceLayer([
          {
            name: "tx-cron",
            description: "transaction-mode bootstrap",
            schedule: Schedule.duration("1 hour"),
            handler: () => Effect.void
          }
        ]).pipe(Layer.provide(makeHookServiceLayer([])), Layer.provide(databaseLayer))
      )
    )
  )
})
