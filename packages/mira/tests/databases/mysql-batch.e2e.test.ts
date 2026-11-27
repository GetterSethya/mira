/**
 * Gated MySQL and MariaDB mutation-batcher suite (issue #72).
 *
 * Run against real engines:
 *
 *   $env:MIRA_TEST_MYSQL_URL = "mysql://root:mira@127.0.0.1:53307/mira_test"
 *   $env:MIRA_TEST_MARIADB_URL = "mysql://root:mira@127.0.0.1:53306/mira_test"
 *   pnpm --filter @gettersethya/mira exec vitest run tests/databases/mysql-batch.e2e.test.ts --no-file-parallelism
 *
 * Each engine suite self-skips when its URL is absent. Every test starts with
 * `reset`, so the two engines never share a physical table set. Do not run this
 * file in parallel with itself: the fixed internal tables would collide.
 *
 * The batch entries run raw MySQL SQL. The `Dialect` value spreads
 * `sqliteDialect` only to satisfy the full `DialectType` shape; the batcher
 * reads `transactionProbe` and nothing else, so no SQLite DDL or native-type
 * behavior is exercised.
 */
import { MysqlClient } from "@effect/sql-mysql2"
import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Data, Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect"
import type { SqlError } from "effect/sql"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import type { ResolvedBatchMutationConfig } from "@/collection-service/mutation-batcher.js"
import {
  BatchMutationStats,
  makeBatchMutationStatsLayer,
  makeMutationBatcherLayer,
  MutationBatcher
} from "@/collection-service/mutation-batcher.js"
import { Dialect } from "@/dialect/dialect.js"
import type { DialectType, TransactionProbeStrategy } from "@/dialect/dialect.js"
import {
  isMysqlTransactionFatal,
  mysqlTransactionProbe
} from "@/dialect/dialect-mysql-transactions.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

type EngineConfig = {
  readonly label: string
  readonly envUrl: string | undefined
  readonly fallbackUrl: string
  readonly prefix: string
}

const ProbeBatch = BaseCollection.define("probe_batch", {
  title: Field.text({ required: true })
})

const batchConfig: ResolvedBatchMutationConfig = {
  queue: {
    // A long window lets the test submit every entry before `flushNow`
    // releases the batch. Under `it.live` the window would otherwise wait 60s.
    windowMs: 60_000,
    maxBatchSize: 100,
    maxQueueSize: 1_000,
    maxQueueBytes: 32 * 1024 * 1024,
    submitTimeoutMs: 10_000
  },
  create: { submitTimeoutMs: 10_000 },
  update: { submitTimeoutMs: 10_000 },
  delete: null
}

class InterfererFinished extends Data.TaggedError("InterfererFinished")<{}> {}

const quote = (name: string) => `\`${name.replaceAll("`", "``")}\``

const makeLayer = (
  url: string,
  maxConnections: number,
  transactionProbe: TransactionProbeStrategy
) => {
  const base = MysqlClient.layer({ url: Redacted.make(url), maxConnections })
  const statsLayer = makeBatchMutationStatsLayer()
  const dialect: DialectType = { ...sqliteDialect, transactionProbe }
  return Layer.mergeAll(
    base,
    statsLayer,
    makeMutationBatcherLayer(batchConfig, statsLayer).pipe(
      Layer.provide(Layer.merge(base, Layer.succeed(Dialect, dialect)))
    )
  )
}

const waitForAdmitted = (count: number) =>
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* stats.snapshot).admitted >= count) return
      yield* Effect.sleep(10)
    }
    return yield* Effect.die(`waitForAdmitted timed out at ${count}`)
  })

const waitForFlush = Effect.gen(function* () {
  const stats = yield* BatchMutationStats
  yield* stats.flushNow
})

const makeEntry = (effect: Effect.Effect<void, SqlError.SqlError>, id: string) => ({
  operation: "create" as const,
  collection: ProbeBatch,
  execute: effect.pipe(Effect.as({ value: { id }, afterCommit: Effect.void })),
  estimatedBytes: 64
})

const defineSuite = (config: EngineConfig) => {
  const enabled = config.envUrl !== undefined
  const describeSuite = enabled ? describe : describe.skip
  const url = config.envUrl ?? config.fallbackUrl
  const accounts = `${config.prefix}accounts`
  const uniqueRows = `${config.prefix}unique_rows`
  const marker = `${config.prefix}marker`

  const reset = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quote(marker)}`).pipe(Effect.ignore)
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quote(uniqueRows)}`).pipe(Effect.ignore)
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${quote(accounts)}`).pipe(Effect.ignore)
    yield* sql.unsafe(`
      CREATE TABLE ${quote(accounts)} (
        id INT PRIMARY KEY,
        v INT NOT NULL
      )
    `)
    yield* sql.unsafe(`
      CREATE TABLE ${quote(uniqueRows)} (
        id VARCHAR(64) PRIMARY KEY,
        code VARCHAR(64) NOT NULL UNIQUE
      )
    `)
    yield* sql.unsafe(`
      CREATE TABLE ${quote(marker)} (
        id VARCHAR(64) PRIMARY KEY
      )
    `)
    yield* sql.unsafe(
      `INSERT INTO ${quote(accounts)} (id, v) VALUES (1, 100), (2, 200), (3, 300), (4, 400)`
    )
    yield* sql.unsafe(`INSERT INTO ${quote(uniqueRows)} (id, code) VALUES ('seed', 'alpha')`)
  })

  const readAccounts = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ id: number; v: number }>`
      SELECT id, v FROM ${sql(accounts)} ORDER BY id
    `
  })

  const readMarker = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ id: string }>`SELECT id FROM ${sql(marker)} ORDER BY id`
  })

  const readCodes = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ code: string }>`
      SELECT code FROM ${sql(uniqueRows)} ORDER BY code
    `
  })

  describeSuite(`${config.label} mutation batcher`, () => {
    it.live(
      "a multi-entry deadlock is classified fatal and nothing commits",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const classified: Array<unknown> = []
            const probe = {
              ...mysqlTransactionProbe,
              isTransactionFatal: (error: unknown) => {
                classified.push(error)
                return mysqlTransactionProbe.isTransactionFatal(error)
              }
            } as const satisfies TransactionProbeStrategy

            const ctx = yield* Layer.build(makeLayer(url, 2, probe))
            yield* reset.pipe(Effect.provide(ctx))
            const ctxB = yield* Layer.build(
              MysqlClient.layer({ url: Redacted.make(url), maxConnections: 1 })
            )

            const aLocked = yield* Deferred.make<void>()
            const bReady = yield* Deferred.make<void>()
            const interferer = yield* Effect.forkChild(
              Effect.gen(function* () {
                const sqlB = yield* SqlClient.SqlClient
                const exit = yield* sqlB
                  .withTransaction(
                    Effect.gen(function* () {
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 2`
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 3`
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 4`
                      yield* Deferred.succeed(bReady, undefined)
                      yield* Deferred.await(aLocked)
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 1`
                      return yield* Effect.fail(new InterfererFinished())
                    })
                  )
                  .pipe(Effect.exit)
                return exit
              }).pipe(Effect.provide(ctxB))
            )

            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const stats = yield* BatchMutationStats
              const batcher = yield* MutationBatcher
              yield* Deferred.await(bReady)

              const first = yield* Effect.forkChild(
                batcher.submit(
                  makeEntry(
                    sql`UPDATE ${sql(accounts)} SET v = v + 1 WHERE id = 1`.pipe(
                      Effect.andThen(Deferred.succeed(aLocked, undefined)),
                      Effect.asVoid
                    ),
                    "first"
                  )
                )
              )
              yield* waitForAdmitted(1)
              const second = yield* Effect.forkChild(
                batcher.submit(
                  makeEntry(
                    sql`UPDATE ${sql(accounts)} SET v = v + 1 WHERE id = 2`.pipe(Effect.asVoid),
                    "second"
                  )
                )
              )
              yield* waitForAdmitted(2)
              yield* waitForFlush

              const exits = [yield* Fiber.await(first), yield* Fiber.await(second)]
              expect(exits.every(Exit.isFailure)).toBe(true)
              expect(classified.length).toBeGreaterThan(0)
              expect(classified.some(isMysqlTransactionFatal)).toBe(true)

              const snapshot = yield* stats.snapshot
              expect(snapshot.commits).toBe(0)
              expect(snapshot.applied).toBe(0)
              expect(snapshot.batches).toBe(0)
              // The fatal classification is exempt from the three-strike close.
              expect(snapshot.consecutiveDefects).toBe(0)
            }).pipe(Effect.provide(ctx))

            yield* Fiber.await(interferer)
            expect(yield* readAccounts.pipe(Effect.provide(ctx))).toEqual([
              { id: 1, v: 100 },
              { id: 2, v: 200 },
              { id: 3, v: 300 },
              { id: 4, v: 400 }
            ])
          })
        ),
      30_000
    )

    it.live(
      "a single-entry deadlock reaches the classifier through the real 1213",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const classified: Array<unknown> = []
            const probe = {
              ...mysqlTransactionProbe,
              isTransactionFatal: (error: unknown) => {
                classified.push(error)
                return mysqlTransactionProbe.isTransactionFatal(error)
              }
            } as const satisfies TransactionProbeStrategy

            const ctx = yield* Layer.build(makeLayer(url, 2, probe))
            yield* reset.pipe(Effect.provide(ctx))
            const ctxB = yield* Layer.build(
              MysqlClient.layer({ url: Redacted.make(url), maxConnections: 1 })
            )

            const aLocked = yield* Deferred.make<void>()
            const bReady = yield* Deferred.make<void>()
            const interferer = yield* Effect.forkChild(
              Effect.gen(function* () {
                const sqlB = yield* SqlClient.SqlClient
                const exit = yield* sqlB
                  .withTransaction(
                    Effect.gen(function* () {
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 2`
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 3`
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 4`
                      yield* Deferred.succeed(bReady, undefined)
                      yield* Deferred.await(aLocked)
                      yield* sqlB`UPDATE ${sqlB(accounts)} SET v = v + 1 WHERE id = 1`
                      return yield* Effect.fail(new InterfererFinished())
                    })
                  )
                  .pipe(Effect.exit)
                return exit
              }).pipe(Effect.provide(ctxB))
            )

            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const stats = yield* BatchMutationStats
              yield* Deferred.await(bReady)

              const entry = yield* Effect.forkChild(
                (yield* MutationBatcher).submit(
                  makeEntry(
                    sql`UPDATE ${sql(accounts)} SET v = v + 1 WHERE id = 1`
                      .pipe(Effect.andThen(Deferred.succeed(aLocked, undefined)))
                      .pipe(
                        Effect.andThen(
                          sql`UPDATE ${sql(accounts)} SET v = v + 1 WHERE id = 2`
                        )
                      )
                      .pipe(Effect.asVoid),
                    "only"
                  )
                )
              )
              yield* waitForAdmitted(1)
              yield* waitForFlush

              const exit = yield* Fiber.await(entry)
              expect(Exit.isFailure(exit)).toBe(true)
              expect(classified.length).toBeGreaterThan(0)
              expect(classified.some(isMysqlTransactionFatal)).toBe(true)
              // A non-fatal verdict would let the empty transaction commit and
              // record one batch. The fatal path skips COMMIT entirely.
              expect((yield* stats.snapshot).commits).toBe(0)
              expect((yield* stats.snapshot).batches).toBe(0)
            }).pipe(Effect.provide(ctx))

            yield* Fiber.await(interferer)
            expect(yield* readAccounts.pipe(Effect.provide(ctx))).toEqual([
              { id: 1, v: 100 },
              { id: 2, v: 200 },
              { id: 3, v: 300 },
              { id: 4, v: 400 }
            ])
          })
        ),
      30_000
    )

    it.live(
      "a duplicate key stays statement-level and the other entry commits",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const classified: Array<unknown> = []
            const probe = {
              ...mysqlTransactionProbe,
              isTransactionFatal: (error: unknown) => {
                classified.push(error)
                return mysqlTransactionProbe.isTransactionFatal(error)
              }
            } as const satisfies TransactionProbeStrategy

            const ctx = yield* Layer.build(makeLayer(url, 1, probe))
            yield* reset.pipe(Effect.provide(ctx))

            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const stats = yield* BatchMutationStats
              const batcher = yield* MutationBatcher

              const duplicate = yield* Effect.forkChild(
                batcher.submit(
                  makeEntry(
                    sql`INSERT INTO ${sql(uniqueRows)} (id, code) VALUES ('dup', 'alpha')`.pipe(
                      Effect.asVoid
                    ),
                    "dup"
                  )
                )
              )
              yield* waitForAdmitted(1)
              const other = yield* Effect.forkChild(
                batcher.submit(
                  makeEntry(
                    sql`INSERT INTO ${sql(uniqueRows)} (id, code) VALUES ('new', 'beta')`.pipe(
                      Effect.asVoid
                    ),
                    "new"
                  )
                )
              )
              yield* waitForAdmitted(2)
              yield* waitForFlush

              const duplicateExit = yield* Fiber.await(duplicate)
              const otherExit = yield* Fiber.await(other)
              expect(Exit.isFailure(duplicateExit)).toBe(true)
              expect(Exit.isSuccess(otherExit)).toBe(true)
              expect(classified.length).toBeGreaterThan(0)
              expect(classified.every((error) => !isMysqlTransactionFatal(error))).toBe(true)
              expect((yield* readCodes.pipe(Effect.provide(ctx))).map((row) => row.code)).toEqual([
                "alpha",
                "beta"
              ])

              const snapshot = yield* stats.snapshot
              expect(snapshot.commits).toBe(1)
              expect(snapshot.applied).toBe(1)
              expect(snapshot.batches).toBe(1)
            }).pipe(Effect.provide(ctx))
          })
        ),
      30_000
    )

    it.live(
      "a killed connection fails every entry and commits nothing",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const classified: Array<unknown> = []
            const probe = {
              ...mysqlTransactionProbe,
              isTransactionFatal: (error: unknown) => {
                classified.push(error)
                return mysqlTransactionProbe.isTransactionFatal(error)
              }
            } as const satisfies TransactionProbeStrategy

            const ctx = yield* Layer.build(makeLayer(url, 1, probe))
            yield* reset.pipe(Effect.provide(ctx))
            const adminCtx = yield* Layer.build(
              MysqlClient.layer({ url: Redacted.make(url), maxConnections: 1 })
            )

            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient
              const stats = yield* BatchMutationStats
              const batcher = yield* MutationBatcher

              const started = yield* Deferred.make<void>()
              const killDone = yield* Deferred.make<void>()
              const ids = yield* sql<{ id: number }>`SELECT CONNECTION_ID() AS id`
              const connectionId = ids[0]?.id
              if (connectionId === undefined) return yield* Effect.die("missing connection id")

              const first = yield* Effect.forkChild(
                batcher.submit(
                  makeEntry(
                    Effect.gen(function* () {
                      yield* Deferred.succeed(started, undefined)
                      yield* Deferred.await(killDone)
                      yield* sql`INSERT INTO ${sql(marker)} (id) VALUES ('e1')`
                    }).pipe(Effect.asVoid),
                    "e1"
                  )
                )
              )
              yield* waitForAdmitted(1)
              const second = yield* Effect.forkChild(
                batcher.submit(
                  makeEntry(
                    sql`INSERT INTO ${sql(marker)} (id) VALUES ('e2')`.pipe(Effect.asVoid),
                    "e2"
                  )
                )
              )
              yield* waitForAdmitted(2)

              // Open the batch transaction, let the first entry start, then kill
              // the connection before it writes. The second entry runs after it.
              yield* waitForFlush
              yield* Deferred.await(started)
              yield* Effect.gen(function* () {
                const admin = yield* SqlClient.SqlClient
                yield* admin.unsafe(`KILL ${connectionId}`)
              }).pipe(Effect.provide(adminCtx))
              yield* Deferred.succeed(killDone, undefined)

              const exits = [yield* Fiber.await(first), yield* Fiber.await(second)]
              expect(exits.every(Exit.isFailure)).toBe(true)
              expect(classified.length).toBeGreaterThan(0)
              expect(classified.every((error) => !isMysqlTransactionFatal(error))).toBe(true)
              expect(yield* readMarker.pipe(Effect.provide(ctx))).toEqual([])
              expect((yield* stats.snapshot).commits).toBe(0)
            }).pipe(Effect.provide(ctx))
          })
        ),
      30_000
    )
  })
}

defineSuite({
  label: "MySQL",
  envUrl: process.env["MIRA_TEST_MYSQL_URL"],
  fallbackUrl: "mysql://root:mira@127.0.0.1:53307/mira_test",
  prefix: "e2e_mysql_batch_"
})

defineSuite({
  label: "MariaDB",
  envUrl: process.env["MIRA_TEST_MARIADB_URL"],
  fallbackUrl: "mysql://root:mira@127.0.0.1:53306/mira_test",
  prefix: "e2e_mariadb_batch_"
})
