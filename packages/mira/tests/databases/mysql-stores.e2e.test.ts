import { MysqlClient } from "@effect/sql-mysql2"
import { describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import mysql from "mysql2/promise"
import { expect } from "vitest"

import { AuthChallengeStore, AuthChallengeStoreLive } from "@/auth/index.js"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { CronService, makeCronServiceLayer } from "@/cron/cron-service.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { mysqlDialect } from "@/dialect/dialect-mysql.js"
import { TokenStore, TokenStoreLive } from "@/http/token-store.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import { RateLimitStore } from "@/rate-limit/index.js"
import { SqlRateLimitStoreLive } from "@/rate-limit/sql.js"

type EngineConfig = {
  readonly label: string
  readonly envUrl: string | undefined
  readonly fallbackUrl: string
}

const engines: ReadonlyArray<EngineConfig> = [
  {
    label: "MySQL",
    envUrl: process.env["MIRA_TEST_MYSQL_URL"],
    fallbackUrl: "mysql://root:mira@127.0.0.1:53307/mira_test"
  },
  {
    label: "MariaDB",
    envUrl: process.env["MIRA_TEST_MARIADB_URL"],
    fallbackUrl: "mysql://root:mira@127.0.0.1:53306/mira_test"
  }
]

const adminUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.pathname = "/"
  return parsed.toString()
}

const databaseUrl = (url: string, name: string) => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

const createDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
      await connection.query(`CREATE DATABASE \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const dropDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const makeLayer = (url: string) => {
  const base = MysqlClient.layer({
    url: Redacted.make(url),
    maxConnections: 2
  })
  const deps = Layer.merge(base, Layer.succeed(Dialect, mysqlDialect))
  const crypto = NodeCryptoLayer
  const config = AppConfigLive.pipe(Layer.provide(Layer.mergeAll(deps, crypto)))
  const hooks = makeHookServiceLayer([])
  const token = TokenStoreLive.pipe(Layer.provide(deps))
  const challenge = AuthChallengeStoreLive.pipe(Layer.provide(deps))
  const rate = SqlRateLimitStoreLive.pipe(Layer.provide(deps))
  const cron = makeCronServiceLayer([
    {
      name: "e2e-mysql-cron",
      schedule: Schedule.duration("24 hours"),
      handler: () => Effect.void
    }
  ]).pipe(Layer.provide(Layer.mergeAll(deps, hooks)))
  return Layer.mergeAll(base, crypto, config, token, challenge, rate, cron)
}

const withEngine = <A, E>(
  url: string,
  body: (layer: ReturnType<typeof makeLayer>) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(
        () =>
          `mira_e2e_stores_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      ),
      (name) => dropDatabase(url, name)
    ).pipe(
      Effect.flatMap((name) =>
        Effect.gen(function* () {
          yield* createDatabase(url, name)
          const layer = makeLayer(databaseUrl(url, name))
          return yield* body(layer)
        })
      )
    )
  )

for (const engine of engines) {
  const enabled = engine.envUrl !== undefined
  const describeEngine = enabled ? describe : describe.skip
  const url = engine.envUrl ?? engine.fallbackUrl

  describeEngine(`${engine.label} internal stores`, () => {
    it.live(
      "boots and round-trips config, tokens, challenges, rate limits, and cron",
      () =>
        withEngine(url, (layer) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const config = yield* AppConfig
            expect(config.appName).toBe("mira")

            const tokens = yield* TokenStore
            yield* tokens.revoke("e2e-jti", Date.now() + 60_000)
            expect(yield* tokens.isRevoked("e2e-jti")).toBe(true)
            expect(yield* tokens.currentGeneration("users", "u1")).toBe(0)
            yield* tokens.bumpGeneration("users", "u1")
            expect(yield* tokens.currentGeneration("users", "u1")).toBe(1)
            yield* tokens.bumpGeneration("users", "u1")
            expect(yield* tokens.currentGeneration("users", "u1")).toBe(2)

            const challenges = yield* AuthChallengeStore
            const now = Date.now()
            yield* challenges.create({
              id: "e2e-challenge",
              collection: "users",
              userId: "u1",
              purpose: "login_otp",
              tokenHash: "hash-1",
              expiresAt: now + 60_000,
              consumedAt: null,
              attempts: 0,
              createdAt: now,
              newEmail: null
            })
            expect(
              yield* challenges.attemptAndConsume("e2e-challenge", 2, now)
            ).toEqual({ attempts: 1, consumed: false })
            expect(
              yield* challenges.attemptAndConsume("e2e-challenge", 2, now + 1)
            ).toEqual({ attempts: 2, consumed: true })
            expect(
              yield* challenges.attemptAndConsume("e2e-challenge", 2, now + 2)
            ).toBeNull()

            const limits = yield* RateLimitStore
            const allowed = yield* limits.increment([
              { bucket: "e2e-bucket", limit: 2, cost: 1, expiresAt: now + 60_000 }
            ])
            expect(allowed).toEqual({ ok: true, counts: [1] })
            const blocked = yield* limits.increment([
              { bucket: "e2e-bucket", limit: 2, cost: 2, expiresAt: now + 60_000 }
            ])
            expect(blocked.ok).toBe(false)

            const mixed = yield* limits.increment([
              { bucket: "e2e-mixed-a", limit: 5, cost: 1, expiresAt: now + 60_000 },
              { bucket: "e2e-mixed-b", limit: 1, cost: 2, expiresAt: now + 60_000 }
            ])
            expect(mixed.ok).toBe(false)
            const mixedAfter = yield* limits.increment([
              { bucket: "e2e-mixed-a", limit: 5, cost: 1, expiresAt: now + 60_000 }
            ])
            expect(mixedAfter).toEqual({ ok: true, counts: [1] })

            const duplicateBuckets = yield* limits.increment([
              { bucket: "e2e-dup", limit: 2, cost: 1, expiresAt: now + 60_000 },
              { bucket: "e2e-dup", limit: 2, cost: 1, expiresAt: now + 60_000 }
            ])
            expect(duplicateBuckets).toEqual({ ok: true, counts: [1, 2] })

            const expired = now - 10 * 60_000
            yield* limits.increment([
              { bucket: "e2e-prune", limit: 1, cost: 1, expiresAt: expired }
            ])
            yield* limits.prune(now)
            const afterPrune = yield* limits.increment([
              { bucket: "e2e-prune", limit: 1, cost: 1, expiresAt: now + 60_000 }
            ])
            expect(afterPrune).toEqual({ ok: true, counts: [1] })

            const concurrent = yield* Effect.all(
              Array.from({ length: 2 }, () =>
                limits.increment([
                  { bucket: "e2e-race", limit: 1, cost: 1, expiresAt: now + 60_000 }
                ])
              ),
              { concurrency: "unbounded" }
            )
            expect(concurrent.filter((result) => result.ok)).toHaveLength(1)

            const raceChallenge = {
              id: "e2e-challenge-race",
              collection: "users",
              userId: "u2",
              purpose: "login_otp" as const,
              tokenHash: "hash-race",
              expiresAt: now + 60_000,
              consumedAt: null,
              attempts: 1,
              createdAt: now,
              newEmail: null
            }
            yield* challenges.create(raceChallenge)
            const raceResults = yield* Effect.all(
              [
                challenges.attemptAndConsume("e2e-challenge-race", 2, now + 1),
                challenges.attemptAndConsume("e2e-challenge-race", 2, now + 1)
              ],
              { concurrency: "unbounded" }
            )
            expect(raceResults.filter((result) => result?.consumed === true)).toHaveLength(1)

            const liveChallenge = {
              id: "e2e-challenge-live",
              collection: "users",
              userId: "u3",
              purpose: "login_otp" as const,
              tokenHash: "hash-live-1",
              expiresAt: now + 60_000,
              consumedAt: null,
              attempts: 0,
              createdAt: now,
              newEmail: null
            }
            yield* challenges.create(liveChallenge)
            const duplicateLive = yield* Effect.exit(
              challenges.create({ ...liveChallenge, id: "e2e-challenge-live-2", tokenHash: "hash-live-2" })
            )
            expect(Exit.isFailure(duplicateLive)).toBe(true)

            const consumeChallenge = {
              id: "e2e-challenge-consume",
              collection: "users",
              userId: "u4",
              purpose: "login_otp" as const,
              tokenHash: "hash-consume",
              expiresAt: now + 60_000,
              consumedAt: null,
              attempts: 0,
              createdAt: now,
              newEmail: null
            }
            yield* challenges.create(consumeChallenge)
            expect(yield* challenges.consumeById("e2e-challenge-consume", now + 1)).toBe(true)
            expect(yield* challenges.consumeById("e2e-challenge-consume", now + 2)).toBe(false)

            const tokenChallenge = {
              ...consumeChallenge,
              id: "e2e-challenge-token",
              tokenHash: "hash-token"
            }
            yield* challenges.create(tokenChallenge)
            expect(
              yield* challenges.consumeToken(
                "users",
                "login_otp",
                "hash-token",
                now + 1
              )
            ).toBe(true)
            expect(
              yield* challenges.consumeToken(
                "users",
                "login_otp",
                "hash-token",
                now + 2
              )
            ).toBe(false)

            const cron = yield* CronService
            yield* cron.runNow("e2e-mysql-cron")
            let rows: ReadonlyArray<{ value: string }> = []
            for (let attempt = 0; attempt < 40; attempt++) {
              rows = yield* sql<{ value: string }>`
                SELECT \`value\` FROM ${sql("_config")} WHERE \`key\` = 'cron_state'
              `
              if (rows[0]?.value !== undefined) break
              yield* Effect.sleep(50)
            }
            expect(rows[0]?.value).toContain("e2e-mysql-cron")
          }).pipe(Effect.provide(layer))
        ),
      120_000
    )

    it.live(
      "re-bootstraps idempotently",
      () =>
        withEngine(url, (layer) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const tables = yield* sql<{ name: string }>`
              SELECT TABLE_NAME AS name FROM information_schema.tables
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME IN ('_config', '_auth_challenges', '_rate_limits', '_revoked_tokens', '_auth_generations')
            `
            expect(tables.length).toBe(5)
            for (let attempt = 0; attempt < 5; attempt++) {
              const lockWait = yield* sql<{ value: number }>`
                SELECT @@SESSION.innodb_lock_wait_timeout AS value
              `
              expect(Number(lockWait[0]?.value)).not.toBe(5)
            }

            yield* Effect.scoped(Layer.build(layer))
          }).pipe(Effect.provide(layer))
        ),
      120_000
    )
  })
}
