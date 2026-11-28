import { MysqlClient } from "@effect/sql-mysql2"
import { describe, it } from "@effect/vitest"
import { Effect, Layer, Predicate, Redacted, Result, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import mysql from "mysql2/promise"
import type { RowDataPacket } from "mysql2/promise"
import { expect } from "vitest"

import { AuthChallengeStore, AuthChallengeStoreLive } from "@/auth/index.js"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { CronService, makeCronServiceLayer } from "@/cron/cron-service.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect, errorHasCode } from "@/dialect/dialect.js"
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
  body: (
    layer: ReturnType<typeof makeLayer>,
    dbUrl: string
  ) => Effect.Effect<A, E>
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
          return yield* body(layer, databaseUrl(url, name))
        })
      )
    )
  )

const readGlobalInnodbWait = (url: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      const [rows] = await connection.query<Array<RowDataPacket>>(
        "SELECT @@GLOBAL.innodb_lock_wait_timeout AS value"
      )
      return Number(rows[0]?.["value"])
    } finally {
      await connection.end()
    }
  })

const setGlobalInnodbWait = (url: string, value: number) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(
        `SET GLOBAL innodb_lock_wait_timeout = ${Math.trunc(value)}`
      )
    } finally {
      await connection.end()
    }
  })

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

            const blockedDuplicate = yield* limits.increment([
              { bucket: "e2e-dup-blocked", limit: 1, cost: 1, expiresAt: now + 60_000 },
              { bucket: "e2e-dup-blocked", limit: 1, cost: 1, expiresAt: now + 60_000 }
            ])
            expect(blockedDuplicate).toEqual({
              ok: false,
              blockedIndices: [1],
              counts: [0, 0]
            })
            const afterBlockedDuplicate = yield* limits.increment([
              { bucket: "e2e-dup-blocked", limit: 1, cost: 1, expiresAt: now + 60_000 }
            ])
            expect(afterBlockedDuplicate).toEqual({ ok: true, counts: [1] })

            const tooLong = yield* Effect.result(
              limits.increment([
                {
                  bucket: "x".repeat(513),
                  limit: 1,
                  cost: 1,
                  expiresAt: now + 60_000
                }
              ])
            )
            expect(Result.isFailure(tooLong)).toBe(true)
            if (Result.isFailure(tooLong)) {
              expect(Predicate.isTagged(tooLong.failure, "RateLimitStoreError")).toBe(
                true
              )
            }

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
            const raceLoser = concurrent.find((result) => !result.ok)
            expect(raceLoser).toEqual({
              ok: false,
              blockedIndices: [0],
              counts: [1]
            })

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
            expect(raceResults.filter((result) => result === null)).toHaveLength(1)
            const raceWinner = raceResults.find((result) => result !== null)
            expect(raceWinner).toEqual({ attempts: 2, consumed: true })
            const raceRow = yield* sql<{
              attempts: number
              consumed_at: number | string | null
            }>`
              SELECT attempts, consumed_at FROM ${sql("_auth_challenges")}
              WHERE id = 'e2e-challenge-race'
            `
            expect(Number(raceRow[0]?.attempts)).toBe(2)
            expect(raceRow[0]?.consumed_at).not.toBeNull()

            const supersedeTarget = {
              id: "e2e-challenge-supersede",
              collection: "users",
              userId: "u5",
              purpose: "login_otp" as const,
              tokenHash: "hash-supersede",
              expiresAt: now + 60_000,
              consumedAt: null,
              attempts: 0,
              createdAt: now,
              newEmail: null
            }
            yield* challenges.create(supersedeTarget)
            yield* challenges.supersedeLive("users", "u5", "login_otp", now + 1)
            expect(
              yield* challenges.findLatestForUser("users", "u5", "login_otp")
            ).toBeUndefined()
            const superseded = yield* challenges.findById(
              "users",
              "e2e-challenge-supersede",
              "login_otp"
            )
            expect(superseded?.consumedAt).toBe(now + 1)

            yield* challenges.create({
              ...supersedeTarget,
              id: "e2e-challenge-many-a",
              tokenHash: "hash-many-a"
            })
            expect(
              yield* challenges.findLatestForUser("users", "u5", "login_otp")
            ).toBeDefined()
            yield* challenges.consumeAllForUser("users", "u5", now + 2)
            const remainingLive = yield* sql<{ id: string }>`
              SELECT id FROM ${sql("_auth_challenges")}
              WHERE collection = 'users' AND user_id = 'u5' AND consumed_at IS NULL
            `
            expect(remainingLive).toHaveLength(0)

            yield* challenges.create({
              ...supersedeTarget,
              id: "e2e-challenge-expired",
              tokenHash: "hash-expired",
              userId: "u6",
              expiresAt: now - 1
            })
            yield* challenges.deleteExpired(now)
            const expiredRows = yield* sql<{ id: string }>`
              SELECT id FROM ${sql("_auth_challenges")}
              WHERE id = 'e2e-challenge-expired'
            `
            expect(expiredRows).toHaveLength(0)

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
            const duplicateLiveAttempt = yield* Effect.result(
              challenges.create({
                ...liveChallenge,
                id: "e2e-challenge-live-2",
                tokenHash: "hash-live-2"
              })
            )
            expect(Result.isFailure(duplicateLiveAttempt)).toBe(true)
            if (Result.isFailure(duplicateLiveAttempt)) {
              expect(
                errorHasCode(duplicateLiveAttempt.failure, [
                  1062,
                  "ER_DUP_ENTRY"
                ])
              ).toBe(true)
            }

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
              const session = yield* sql<{
                sessionLockWait: number
                globalLockWait: number
                sessionInnodbWait: number
                globalInnodbWait: number
              }>`
                SELECT @@SESSION.lock_wait_timeout AS sessionLockWait,
                       @@GLOBAL.lock_wait_timeout AS globalLockWait,
                       @@SESSION.innodb_lock_wait_timeout AS sessionInnodbWait,
                       @@GLOBAL.innodb_lock_wait_timeout AS globalInnodbWait
              `
              expect(Number(session[0]?.sessionLockWait)).toBe(
                Number(session[0]?.globalLockWait)
              )
              expect(Number(session[0]?.sessionInnodbWait)).toBe(
                Number(session[0]?.globalInnodbWait)
              )
            }

            yield* Effect.scoped(Layer.build(layer))
            const afterRebuild = yield* sql<{ name: string }>`
              SELECT TABLE_NAME AS name FROM information_schema.tables
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME IN ('_config', '_auth_challenges', '_rate_limits', '_revoked_tokens', '_auth_generations')
            `
            expect(afterRebuild.length).toBe(5)
          }).pipe(Effect.provide(layer))
        ),
      120_000
    )
    it.live(
      "converges on one jwt_secret across concurrent first boots",
      () =>
        withEngine(url, (_layer, dbUrl) =>
          Effect.gen(function* () {
            const readSecret = (layer: ReturnType<typeof makeLayer>) =>
              Effect.gen(function* () {
                const config = yield* AppConfig
                return Redacted.value(config.jwtSecret)
              }).pipe(Effect.provide(layer))

            const secrets = yield* Effect.all(
              [readSecret(makeLayer(dbUrl)), readSecret(makeLayer(dbUrl))],
              { concurrency: "unbounded" }
            )
            expect(secrets[0]).toBe(secrets[1])
            expect(secrets[0]).toMatch(/^[0-9a-f]{96}$/)

            const stored = yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const rows = yield* sql<{ n: number }>`
                SELECT COUNT(*) AS n FROM ${sql("_config")}
                WHERE \`key\` = 'jwt_secret'
              `
              return Number(rows[0]?.n)
            }).pipe(Effect.provide(makeLayer(dbUrl)))
            expect(stored).toBe(1)
          })
        ),
      180_000
    )
    it.live(
      "fails fast when a challenge or rate-limit row lock is held",
      () =>
        withEngine(url, (layer, dbUrl) =>
          Effect.gen(function* () {
            const originalWait = yield* readGlobalInnodbWait(url)
            yield* setGlobalInnodbWait(url, 1)
            return yield* Effect.scoped(
              Effect.gen(function* () {
              const challenges = yield* AuthChallengeStore
              const limits = yield* RateLimitStore
              const now = Date.now()
              yield* challenges.create({
                id: "e2e-challenge-held",
                collection: "users",
                userId: "u9",
                purpose: "login_otp",
                tokenHash: "hash-held",
                expiresAt: now + 60_000,
                consumedAt: null,
                attempts: 0,
                createdAt: now,
                newEmail: null
              })
              yield* limits.increment([
                { bucket: "e2e-held", limit: 10, cost: 1, expiresAt: now + 60_000 }
              ])

              const holder = yield* Effect.acquireRelease(
                Effect.promise(() => mysql.createConnection(dbUrl)),
                (connection) => Effect.promise(() => connection.end())
              )
              yield* Effect.promise(() => holder.beginTransaction())
              yield* Effect.promise(() =>
                holder.query(
                  "SELECT id FROM `_auth_challenges` WHERE id = ? FOR UPDATE",
                  ["e2e-challenge-held"]
                )
              )
              yield* Effect.promise(() =>
                holder.query(
                  "SELECT bucket FROM `_rate_limits` WHERE bucket = ? FOR UPDATE",
                  ["e2e-held"]
                )
              )

              const challengeStarted = Date.now()
              const challengeAttempt = yield* Effect.result(
                challenges.attemptAndConsume("e2e-challenge-held", 2, now + 1)
              )
              const challengeElapsed = Date.now() - challengeStarted
              expect(Result.isFailure(challengeAttempt)).toBe(true)
              if (Result.isFailure(challengeAttempt)) {
                expect(Predicate.isTagged(challengeAttempt.failure, "SqlError")).toBe(
                  true
                )
              }
              expect(challengeElapsed).toBeGreaterThanOrEqual(1_500)
              expect(challengeElapsed).toBeLessThan(15_000)

              const limitStarted = Date.now()
              const limitAttempt = yield* Effect.result(
                limits.increment([
                  { bucket: "e2e-held", limit: 10, cost: 1, expiresAt: now + 60_000 }
                ])
              )
              const limitElapsed = Date.now() - limitStarted
              expect(Result.isFailure(limitAttempt)).toBe(true)
              if (Result.isFailure(limitAttempt)) {
                expect(
                  Predicate.isTagged(limitAttempt.failure, "RateLimitStoreError")
                ).toBe(true)
              }
              expect(limitElapsed).toBeGreaterThanOrEqual(1_500)
              expect(limitElapsed).toBeLessThan(15_000)

              yield* Effect.promise(() => holder.rollback())

              expect(
                yield* challenges.attemptAndConsume("e2e-challenge-held", 2, now + 2)
              ).toEqual({ attempts: 1, consumed: false })
              expect(
                yield* limits.increment([
                  { bucket: "e2e-held", limit: 10, cost: 1, expiresAt: now + 60_000 }
                ])
              ).toEqual({ ok: true, counts: [2] })
            }).pipe(
              Effect.provide(layer)
            )
            ).pipe(Effect.ensuring(setGlobalInnodbWait(url, originalWait)))
          })
        ),
      180_000
    )
  })
}

