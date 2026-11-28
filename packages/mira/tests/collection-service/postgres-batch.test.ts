import { PgClient } from "@effect/sql-pg"
import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Cause, Data, Effect, Exit, Fiber, Layer, Redacted, Result } from "effect"
import { SqlClient } from "effect/sql"
import { isSqlError } from "effect/sql/SqlError"
import { expect } from "vitest"

import type { CollectionError } from "@/collection-service/errors.js"
import {
  BatchMutationStats,
  MutationBatcher,
  estimateRowBytes,
  makeBatchMutationStatsLayer,
  makeMutationBatcherLayer,
  probeTransactionAlive,
  type ResolvedBatchMutationConfig
} from "@/collection-service/mutation-batcher.js"
import { Dialect, type DialectType, type TransactionProbeStrategy } from "@/dialect/dialect.js"
import { postgresDialect } from "@/dialect/dialect-postgres.js"

/**
 * Environment-gated PostgreSQL test for issue #54: a mid-batch statement
 * failure must isolate to its entry when the dialect declares the
 * `select-only` probe, and the misfiring `nested-begin` probe must abort the
 * batch instead. Requires a running PostgreSQL server; the file self-skips
 * when `MIRA_TEST_POSTGRES_URL` is unset.
 */
const postgresUrl = process.env["MIRA_TEST_POSTGRES_URL"]

if (postgresUrl === undefined) {
  describe.skip("PostgreSQL mutation batch transaction probe requires MIRA_TEST_POSTGRES_URL", () => {
    it("requires MIRA_TEST_POSTGRES_URL", () => {})
  })
} else {
  const url = postgresUrl

  /**
   * Local copy of the SQLite test's `batchedConfig` (fixtures are not
   * exported). The large window keeps the flusher waiting until `flushNow`
   * releases it, so every batch is deterministic.
   */
  const batchedConfig: ResolvedBatchMutationConfig = {
    queue: {
      windowMs: 60_000,
      maxBatchSize: 100,
      maxQueueSize: 1_000,
      maxQueueBytes: 32 * 1024 * 1024,
      submitTimeoutMs: 10_000
    },
    create: { submitTimeoutMs: 10_000 },
    update: null,
    delete: null
  }

  const Posts = BaseCollection.define("batch_posts", {
    title: Field.text({ required: true })
  })

  /**
   * Each call builds a fresh layer value, so every test gets its own queue,
   * flusher, and stats instance and never observes another test's batch.
   *
   * The exported PostgreSQL dialect is used directly; the negative control
   * overrides only `transactionProbe`, the member under test.
   */
  const makeLayer = (transactionProbe: TransactionProbeStrategy) => {
    const statsLayer = makeBatchMutationStatsLayer()
    const dialect: DialectType = { ...postgresDialect, transactionProbe }
    return Layer.merge(
      makeMutationBatcherLayer(batchedConfig, statsLayer).pipe(
        Layer.provideMerge(Layer.merge(PgClient.layer({ url: Redacted.make(url) }), Layer.succeed(Dialect, dialect)))
      ),
      statsLayer
    )
  }

  /**
   * Each test resets its own fixture state first, so tests never observe
   * another test's rows even against a shared server.
   */
  const resetFixture = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`DROP TABLE IF EXISTS batch_posts`)
    yield* sql.unsafe(`CREATE TABLE batch_posts (id text PRIMARY KEY, title text)`)
    yield* sql`INSERT INTO batch_posts (id, title) VALUES (${"seed"}, ${"seed"})`
  })

  const listIds = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: string }>`SELECT id FROM batch_posts ORDER BY id`
    return rows.map((row) => row.id)
  })

  class WaitTimeout extends Data.TaggedError("WaitTimeout")<{ readonly what: string }> {}

  /**
   * Real-time tick used by the polling helpers. `Effect.sleep` cannot be used
   * here: under `it.effect` it is driven by `TestClock` and would never fire.
   */
  const tick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))

  const waitFor = (what: string, count: number, read: Effect.Effect<number>) =>
    Effect.gen(function* () {
      for (let spin = 0; spin < 2_000; spin += 1) {
        if ((yield* read) >= count) return
        yield* Effect.yieldNow
        yield* tick
      }
      return yield* new WaitTimeout({ what })
    })

  /** Deferreds are completed before stats are recorded, so poll counters separately. */
  const waitForAdmitted = (count: number) =>
    Effect.gen(function* () {
      const stats = yield* BatchMutationStats
      yield* waitFor("admitted", count, stats.snapshot.pipe(Effect.map((snapshot) => snapshot.admitted)))
    })

  const waitForBatches = (count: number) =>
    Effect.gen(function* () {
      const stats = yield* BatchMutationStats
      yield* waitFor("batches", count, stats.snapshot.pipe(Effect.map((snapshot) => snapshot.batches)))
    })

  /**
   * The `SqlError` reason tag behind a failed deferred, or `undefined` when
   * the exit succeeded. The pg driver derives `UniqueViolation` from SQLSTATE
   * 23505.
   */
  const reasonTagOf = (exit: Exit.Exit<unknown, CollectionError>): string | undefined => {
    if (Exit.isSuccess(exit)) return undefined
    return Cause.findFail(exit.cause).pipe(
      Result.match({
        onFailure: () => undefined,
        onSuccess: (failure) => (isSqlError(failure.error) ? failure.error.reason._tag : undefined)
      })
    )
  }

  /**
   * The multi-entry flow shared by the isolation test and the negative
   * control: fork three submits, wait until all are admitted, release the
   * flush explicitly, and join. The middle entry violates the primary key, so
   * the failing entry is not last.
   *
   * Fork order is admission order: each submit admits synchronously before
   * its fiber suspends on the deferred, so the exits align with the entries.
   * The `sql` client is captured in the test fiber, so the entry `execute`
   * effects need no extra requirements.
   */
  const runBatchedEntries = (sql: SqlClient.SqlClient) =>
    Effect.gen(function* () {
      const batcher = yield* MutationBatcher
      const stats = yield* BatchMutationStats

      const submit = (id: string, title: string) =>
        batcher.submit({
          operation: "create",
          collection: Posts,
          estimatedBytes: estimateRowBytes({ id, title }),
          execute: sql`INSERT INTO batch_posts (id, title) VALUES (${id}, ${title})`.pipe(
            Effect.as({ value: { id, title }, afterCommit: Effect.void })
          )
        })

      const fiber = yield* Effect.forkChild(
        Effect.forEach(
          [submit("a", "alpha"), submit("a", "dup"), submit("c", "charlie")],
          (effect) => Effect.exit(effect),
          { concurrency: "unbounded" }
        )
      )
      yield* waitForAdmitted(3)
      yield* stats.flushNow
      return yield* Fiber.join(fiber)
    })

  describe("PostgreSQL mutation batch transaction probe", () => {
    it.effect("isolates a mid-batch unique violation from already successful entries", () =>
      Effect.gen(function* () {
        yield* resetFixture
        const sql = yield* SqlClient.SqlClient
        const stats = yield* BatchMutationStats
        const exits = yield* runBatchedEntries(sql)
        const [first, middle, last] = exits

        yield* waitForBatches(1)

        expect(Exit.isSuccess(first)).toBe(true)
        expect(Exit.isSuccess(last)).toBe(true)
        if (Exit.isSuccess(first)) expect(first.value["id"]).toBe("a")
        if (Exit.isSuccess(last)) expect(last.value["id"]).toBe("c")

        expect(Exit.isFailure(middle)).toBe(true)
        expect(reasonTagOf(middle)).toBe("UniqueViolation")

        // The committed rows are exactly seed, a, and c (listed in id order):
        // the failing middle entry must not roll back the others.
        expect(yield* listIds).toEqual(["a", "c", "seed"])

        const snapshot = yield* stats.snapshot
        expect(snapshot.batches).toBe(1)
        expect(snapshot.applied).toBe(2)
      }).pipe(Effect.provide(makeLayer("select-only")))
    )

    it.effect("aborts a single-entry batch on a unique violation without committing", () =>
      Effect.gen(function* () {
        yield* resetFixture
        const sql = yield* SqlClient.SqlClient
        const batcher = yield* MutationBatcher
        const stats = yield* BatchMutationStats

        const fiber = yield* Effect.forkChild(
          batcher.submit({
            operation: "create",
            collection: Posts,
            estimatedBytes: estimateRowBytes({ id: "seed", title: "dup" }),
            execute: sql`INSERT INTO batch_posts (id, title) VALUES (${"seed"}, ${"dup"})`.pipe(
              Effect.as({ value: { id: "seed", title: "dup" }, afterCommit: Effect.void })
            )
          })
        )
        yield* waitForAdmitted(1)
        yield* stats.flushNow
        const exit = yield* Effect.exit(Fiber.join(fiber))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(reasonTagOf(exit)).toBe("UniqueViolation")

        // The single-entry fast path has no savepoint, so the failed insert
        // aborts the transaction and nothing commits.
        expect(yield* listIds).toEqual(["seed"])
      }).pipe(Effect.provide(makeLayer("select-only")))
    )

    it.effect("negative control: the nested-begin probe aborts every entry", () =>
      Effect.gen(function* () {
        yield* resetFixture
        const sql = yield* SqlClient.SqlClient
        const exits = yield* runBatchedEntries(sql)
        const [first, middle, last] = exits

        // On PostgreSQL a nested BEGIN warns and succeeds, so the probe
        // misreads the live transaction as dead and its ROLLBACK aborts the
        // whole batch: every entry fails and nothing commits.
        expect(Exit.isFailure(first)).toBe(true)
        expect(Exit.isFailure(middle)).toBe(true)
        expect(Exit.isFailure(last)).toBe(true)
        expect(yield* listIds).toEqual(["seed"])
      }).pipe(Effect.provide(makeLayer("nested-begin")))
    )

    it.effect("pins the bug premise: the nested-begin probe misreads a live transaction", () =>
      Effect.gen(function* () {
        yield* resetFixture
        const sql = yield* SqlClient.SqlClient

        const probe = yield* sql.withTransaction(probeTransactionAlive(sql, "nested-begin"))

        expect(probe.alive).toBe(false)
      }).pipe(Effect.provide(makeLayer("select-only")))
    )
  })
}
