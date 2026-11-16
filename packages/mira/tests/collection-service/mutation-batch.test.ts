import { randomBytes } from "node:crypto"

import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Cause, Clock, Data, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Result, Scope, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule, MiraPlugin } from "@/app/index.js"
import { Mira } from "@/app/index.js"
import { makeCachedCollectionServiceLayer } from "@/cache/cached-collection.js"
import {
  CollectionService,
  makeBatchedCollectionServiceLayer,
  makeCollectionServiceLayer
} from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import type {
  BatchMutationStatsSnapshot,
  ResolvedBatchMutationConfig
} from "@/collection-service/mutation-batcher.js"
import {
  MutationBatcher,
  BatchMutationStats,
  estimateRowBytes,
  makeMutationBatcherLayer,
  makeBatchMutationStatsLayer,
  probeTransactionAlive,
  resolveBatchMutationConfig,
  resolveBatchOperationConfig
} from "@/collection-service/mutation-batcher.js"
import type { CollectionError } from "@/collection-service/errors.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { makeHookCollectionServiceLayer } from "@/hooks/hook-collection.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { NodePlatform } from "@/platforms/node.js"
import { RepositoryLive } from "@/repository/repository.js"
import type { Repository } from "@/repository/repository.js"
import { LocalFileStorage } from "@/storage/index.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import type { AuthService } from "@/http/auth.js"
import type { Dialect as DialectService } from "@/dialect/dialect.js"
import type { FileStorage as FileStorageService } from "@/storage/storage.js"
import type { CompletedSpan } from "@/telemetry/tracer.js"
import { makeConsoleTracer } from "@/telemetry/tracer.js"

// ---------------------------------------------------------------------------
// Shared test scaffolding
// ---------------------------------------------------------------------------

const FileStorageTest = Layer.succeed(
  FileStorage,
  FileStorage.of({
    upload: (key) => Effect.succeed(key),
    delete: () => Effect.void,
    url: (key) => `/files/${key}`,
    read: (key) => Effect.fail(new FileStorageNotFound({ key })),
    exists: () => Effect.succeed(false),
    list: () => Effect.succeed([])
  })
)

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const DialectTest = Layer.succeed(Dialect, sqliteDialect)

const noCtx: RequestCtx = { headers: {}, query: {} }
const adminCtx: RequestCtx = { headers: {}, query: {}, admin: true }

const postsDef = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  published: Field.boolean({ default: false }),
  // Only used by the deferred-foreign-key commit-failure tests.
  parentId: Field.text({ required: false })
})
const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const Posts = applyRulesToCollections([postsDef], [postsRules])[0]

const usersDef = AuthCollection.define("users", {})
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const Users = applyRulesToCollections([usersDef], [usersRules])[0]

const guardedDef = BaseCollection.define("guarded", {
  title: Field.text({ required: true })
})
const guardedRules = defineRule(guardedDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.authId(Users).eq(R.literal("allowed"))
}))
const Guarded = applyRulesToCollections([guardedDef], [guardedRules])[0]

const bodyGuardedDef = BaseCollection.define("body_guarded", {
  title: Field.text({ required: true })
})
const bodyGuardedRules = defineRule(bodyGuardedDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.request("body", "token").eq(R.literal("allow"))
}))
const BodyGuarded = applyRulesToCollections([bodyGuardedDef], [bodyGuardedRules])[0]

/** Long windows so only an explicit `flushNow` releases a batch under TestClock. */
const batchedConfig: ResolvedBatchMutationConfig = {
  queue: {
    windowMs: 60_000,
    maxBatchSize: 100,
    maxQueueSize: 1_000,
    maxQueueBytes: 32 * 1024 * 1024,
    submitTimeoutMs: 60_000
  },
  create: { submitTimeoutMs: 60_000 },
  update: null,
  delete: null
}

const withQueue = (
  config: ResolvedBatchMutationConfig,
  overrides: Partial<NonNullable<ResolvedBatchMutationConfig["queue"]>>
): ResolvedBatchMutationConfig => ({
  ...config,
  queue: config.queue === null ? null : { ...config.queue, ...overrides }
})

const mutationConfig: ResolvedBatchMutationConfig = {
  ...batchedConfig,
  update: { submitTimeoutMs: 60_000 },
  delete: { submitTimeoutMs: 60_000 }
}

type ServiceRequirements = Repository | SqlClient.SqlClient | FileStorageService | DialectService | AuthService

function serviceDeps<A, E>(
  layer: Layer.Layer<A, E, ServiceRequirements>
): Layer.Layer<A, E, never> {
  return layer.pipe(
    Layer.provide(RepositoryLive),
    Layer.provide(sqliteLayer),
    Layer.provide(FileStorageTest),
    Layer.provide(NodeCryptoLayer),
    Layer.provide(DialectTest),
    Layer.provide(NodeAuthServiceLayer)
  )
}

function batchedLayer(
  collections: ReadonlyArray<AnyCollectionDef> = [Posts],
  config: ResolvedBatchMutationConfig = batchedConfig,
  statsLayer: Layer.Layer<BatchMutationStats> = makeBatchMutationStatsLayer()
) {
  const service = serviceDeps(makeBatchedCollectionServiceLayer(collections, config, statsLayer))
  return Layer.mergeAll(service, statsLayer, sqliteLayer, FileStorageTest, NodeCryptoLayer)
}

const setupPostsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "parents" ("id" TEXT PRIMARY KEY)`)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"     INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"        TEXT NOT NULL UNIQUE,
      "title"     TEXT NOT NULL,
      "published" INTEGER NOT NULL DEFAULT 0,
      "parentId"  TEXT REFERENCES "parents"("id") DEFERRABLE INITIALLY DEFERRED,
      "created"   TEXT NOT NULL,
      "updated"   TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DROP TRIGGER IF EXISTS "posts_poison"`)
  yield* sql.unsafe(`DROP INDEX IF EXISTS "posts_title_unique"`)
  yield* sql.unsafe(`DELETE FROM "posts"`)
})

const setupGuardedTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "guarded" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "guarded"`)
})

const setupBodyGuardedTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "body_guarded" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "body_guarded"`)
})

const setupUsersTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "users" (
      "seqId"         INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"            TEXT NOT NULL UNIQUE,
      "email"         TEXT NOT NULL,
      "password"      TEXT NOT NULL,
      "emailVerified" INTEGER NOT NULL DEFAULT 0,
      "role"          TEXT NOT NULL DEFAULT 'user',
      "created"       TEXT NOT NULL,
      "updated"       TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "users"`)
})

const countPosts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql("posts")}`
  return Number(rows[0]?.count ?? 0)
})

class WaitTimeout extends Data.TaggedError("WaitTimeout")<{ readonly what: string }> {}

class InjectedFlushDefect extends Data.TaggedError("InjectedFlushDefect")<{}> {}

class ProbeAbort extends Data.TaggedError("ProbeAbort")<{}> {}

/**
 * Real-time tick used by the polling helpers. `Effect.sleep` cannot be used
 * here: under `it.effect` it is driven by `TestClock` and would never fire.
 */
const tick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1)))

/** Wait until `count` creates have been admitted to the batch queue. */
const waitFor = (what: string, count: number, read: Effect.Effect<number>) =>
  Effect.gen(function* () {
    for (let spin = 0; spin < 2_000; spin += 1) {
      if ((yield* read) >= count) return
      yield* Effect.yieldNow
      yield* tick
    }
    return yield* Effect.fail(new WaitTimeout({ what }))
  })

const waitForAdmitted = (count: number) =>
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    yield* waitFor("admitted", count, stats.snapshot.pipe(Effect.map((snapshot) => snapshot.admitted)))
  })

const waitForDefects = (count: number) =>
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    yield* waitFor("defects", count, stats.snapshot.pipe(Effect.map((snapshot) => snapshot.consecutiveDefects)))
  })

/**
 * Deferreds are completed before stats are recorded (a committed request must
 * not depend on a counter), so a test that reads counters right after a create
 * must wait for the flush to be counted.
 */
const waitForBatches = (count: number) =>
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    yield* waitFor("batches", count, stats.snapshot.pipe(Effect.map((snapshot) => snapshot.batches)))
  })

const waitForCommits = (count: number) =>
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    yield* waitFor("commits", count, stats.snapshot.pipe(Effect.map((snapshot) => snapshot.commits)))
  })

const waitForOperationApplied = (operation: "create" | "update" | "delete", count: number) =>
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    yield* waitFor(
      `${operation}.applied`,
      count,
      stats.snapshot.pipe(Effect.map((snapshot) => snapshot.operations[operation].applied))
    )
  })

/**
 * Run every create concurrently, wait until all of them are queued (or the
 * expected subset is), then release the flush. Deterministic under TestClock:
 * the window never elapses on its own.
 */
const collectBatched = <A>(
  creates: ReadonlyArray<Effect.Effect<A, CollectionError>>,
  admittedCount: number = creates.length
) =>
  Effect.gen(function* () {
    const stats = yield* BatchMutationStats
    const fiber = yield* Effect.forkChild(
      Effect.forEach(creates, (create) => Effect.exit(create), { concurrency: "unbounded" })
    )
    yield* waitForAdmitted(admittedCount)
    yield* stats.flushNow
    return yield* Fiber.join(fiber)
  })
function failureTag(exit: Exit.Exit<unknown, CollectionError>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined
  return Cause.findFail(exit.cause).pipe(
    Result.match({
      onFailure: () => undefined,
      onSuccess: (failure) => failure.error._tag
    })
  )
}

// ---------------------------------------------------------------------------
// Deterministic stats layer for tests that need a seam (defects, commit signal)
// ---------------------------------------------------------------------------

const emptyOperationStats = {
  batches: 0,
  applied: 0,
  maxBatchSize: 0,
  lastBatchSizes: [],
  rejected: 0,
  timedOut: 0,
  admitted: 0,
  cleanupAbandoned: 0
} as const

const emptySnapshot: BatchMutationStatsSnapshot = {
  commits: 0,
  inlineCommits: 0,
  batches: 0,
  applied: 0,
  maxBatchSize: 0,
  lastBatchSizes: [],
  lastFlushDurationsMs: [],
  rejected: 0,
  consecutiveDefects: 0,
  timedOut: 0,
  admitted: 0,
  cleanupAbandoned: 0,
  operations: {
    create: emptyOperationStats,
    update: emptyOperationStats,
    delete: emptyOperationStats
  }
}

function makeInstrumentedStatsLayer(options: {
  readonly failFlushTimes?: number
  readonly commitSignal?: Deferred.Deferred<void>
} = {}): Layer.Layer<BatchMutationStats> {
  return Layer.effect(
    BatchMutationStats,
    Effect.gen(function* () {
      const state = yield* Ref.make<BatchMutationStatsSnapshot>(emptySnapshot)
      const failuresLeft = yield* Ref.make(options.failFlushTimes ?? 0)
      const flushSignal = yield* Queue.sliding<void>(1)

      return BatchMutationStats.of({
        flushSignal,
        snapshot: Ref.get(state),
        reset: Ref.set(state, emptySnapshot),
        recordCommit: Effect.gen(function* () {
          yield* Ref.update(state, (current) => ({ ...current, commits: current.commits + 1 }))
          if (options.commitSignal !== undefined) {
            yield* Deferred.succeed(options.commitSignal, undefined)
          }
        }),
        recordInlineCommit: () =>
          Ref.update(state, (current) => ({
            ...current,
            inlineCommits: current.inlineCommits + 1
          })),
        recordFlush: (flush) =>
          Effect.gen(function* () {
            const remaining = yield* Ref.get(failuresLeft)
            if (remaining > 0) {
              yield* Ref.update(failuresLeft, (current) => current - 1)
              return yield* Effect.die(new InjectedFlushDefect())
            }
            yield* Ref.update(state, (current) => ({
              ...current,
              batches: current.batches + 1,
              applied: current.applied + flush.applied,
              maxBatchSize: Math.max(current.maxBatchSize, flush.size),
              lastBatchSizes: [...current.lastBatchSizes, flush.size],
              consecutiveDefects: 0
            }))
          }),
        recordRejected: () =>
          Ref.update(state, (current) => ({ ...current, rejected: current.rejected + 1 })),
        recordDefect: Ref.update(state, (current) => ({
          ...current,
          consecutiveDefects: current.consecutiveDefects + 1
        })),
        recordTimeout: () =>
          Ref.update(state, (current) => ({ ...current, timedOut: current.timedOut + 1 })),
        recordAdmitted: () =>
          Ref.update(state, (current) => ({ ...current, admitted: current.admitted + 1 })),
        recordCleanupAbandoned: () =>
          Ref.update(state, (current) => ({
            ...current,
            cleanupAbandoned: current.cleanupAbandoned + 1
          })),
        flushNow: Queue.offer(flushSignal, undefined).pipe(Effect.asVoid)
      })
    })
  )
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("resolveBatchOperationConfig", () => {
  it.effect("returns null unless batching is explicitly enabled", () =>
    Effect.sync(() => {
      expect(resolveBatchOperationConfig()).toBeNull()
      expect(resolveBatchOperationConfig({})).toBeNull()
      expect(resolveBatchOperationConfig({ enabled: false, windowMs: 10 })).toBeNull()
    })
  )

  it.effect("applies the documented defaults when enabled", () =>
    Effect.sync(() => {
      expect(resolveBatchOperationConfig({ enabled: true })).toEqual({
        submitTimeoutMs: 10_000
      })
    })
  )

  it.effect("accepts a fractional window (0.5 ms) and keeps integer counts", () =>
    Effect.sync(() => {
      const resolved = resolveBatchMutationConfig({ windowMs: 0.5, create: {} })
      expect(resolved.queue?.windowMs).toBe(0.5)
      expect(() => resolveBatchOperationConfig({ enabled: true, maxBatchSize: 1.5 })).toThrowError(
        /maxBatchSize/
      )
    })
  )

  it.effect("keeps explicit overrides", () =>
    Effect.sync(() => {
      const resolved = resolveBatchMutationConfig({
        windowMs: 0,
        maxBatchSize: 5,
        maxQueueSize: 7,
        maxQueueBytes: 1_024,
        submitTimeoutMs: 25,
        create: {}
      })
      expect(resolved.queue).toEqual({
        windowMs: 0,
        maxBatchSize: 5,
        maxQueueSize: 7,
        maxQueueBytes: 1_024,
        submitTimeoutMs: 25
      })
    })
  )

  it.effect("rejects invalid values and names the field", () =>
    Effect.sync(() => {
      expect(() => resolveBatchOperationConfig({ enabled: true, windowMs: -1 })).toThrowError(/windowMs/)
      expect(() => resolveBatchOperationConfig({ enabled: true, maxBatchSize: 0 })).toThrowError(/maxBatchSize/)
      expect(() => resolveBatchOperationConfig({ enabled: true, maxQueueSize: 0 })).toThrowError(/maxQueueSize/)
      expect(() => resolveBatchOperationConfig({ enabled: true, maxQueueBytes: 0 })).toThrowError(/maxQueueBytes/)
      expect(() => resolveBatchOperationConfig({ enabled: true, submitTimeoutMs: 0 })).toThrowError(
        /submitTimeoutMs/
      )
      expect(() => resolveBatchOperationConfig({ enabled: true, maxBatchSize: 1.5 })).toThrowError(/maxBatchSize/)
    })
  )

  it.effect("estimates row bytes from payload shape", () =>
    Effect.sync(() => {
      expect(estimateRowBytes({ title: "abcd" })).toBe(16 + 5 * 2 + 4 * 2)
      expect(estimateRowBytes({ published: true })).toBe(16 + 9 * 2 + 1)
      expect(estimateRowBytes([1, 2])).toBe(8 + 8 + 8)
      expect(estimateRowBytes(null)).toBe(0)
    })
  )
})

describe("resolveBatchMutationConfig", () => {
  it.effect("is fully disabled when no mutation operation is configured", () =>
    Effect.sync(() => {
      expect(resolveBatchMutationConfig()).toEqual({
        queue: null,
        create: null,
        update: null,
        delete: null
      })
      expect(resolveBatchMutationConfig({})).toEqual({
        queue: null,
        create: null,
        update: null,
        delete: null
      })
    })
  )

  it.effect("enables create for an empty create object", () =>
    Effect.sync(() => {
      expect(resolveBatchMutationConfig({ create: {} }).create).toEqual({
        submitTimeoutMs: 10_000
      })
    })
  )

  it.effect("lets per-operation values tighten shared defaults", () =>
    Effect.sync(() => {
      const resolved = resolveBatchMutationConfig({
        windowMs: 5,
        maxBatchSize: 20,
        create: { windowMs: 1, maxBatchSize: 10 }
      })
      expect(resolved.queue?.windowMs).toBe(1)
      expect(resolved.queue?.maxBatchSize).toBe(10)
    })
  )

  it.effect("respects enabled: false", () =>
    Effect.sync(() => {
      expect(resolveBatchMutationConfig({ create: { enabled: false } }).create).toBeNull()
    })
  )

  it.effect("resolves update and delete batching", () =>
    Effect.sync(() => {
      expect(resolveBatchMutationConfig({ update: {} }).update).not.toBeNull()
      expect(resolveBatchMutationConfig({ delete: {} }).delete).not.toBeNull()
      expect(resolveBatchMutationConfig({ update: { enabled: false } }).update).toBeNull()
    })
  )
})

// ---------------------------------------------------------------------------
// Batched inserts
// ---------------------------------------------------------------------------

describe("create batching", () => {
  it.effect("batches 20 concurrent creates, maps every response to its payload, and commits once", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const payloads = Array.from({ length: 20 }, (_, index) => ({ title: `title-${index}` }))
      const exits = yield* collectBatched(payloads.map((payload) => svc.create(Posts, payload, noCtx)))
      const rows = exits.map((exit) => (Exit.isSuccess(exit) ? exit.value : undefined))

      expect(rows.every((row) => row !== undefined)).toBe(true)
      expect(rows.map((row) => row?.["title"])).toEqual(payloads.map((payload) => payload.title))
      expect(new Set(rows.map((row) => row?.["id"])).size).toBe(20)

      yield* waitForBatches(1)
      const snapshot = yield* stats.snapshot
      expect(snapshot.batches).toBe(1)
      expect(snapshot.applied).toBe(20)
      expect(snapshot.commits).toBe(1)
      expect(snapshot.maxBatchSize).toBe(20)
      expect(snapshot.commits).toBeLessThan(snapshot.applied)

      const page = yield* svc.list(Posts, null, 100, noCtx)
      expect(page.items.length).toBe(20)
    }).pipe(Effect.provide(batchedLayer()))
  )

  it.effect("a prepare failure fails only that request and never enters the queue", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const creates = [
        svc.create(Posts, { title: "valid-0" }, noCtx),
        svc.create(Posts, {}, noCtx),
        ...Array.from({ length: 4 }, (_, index) => svc.create(Posts, { title: `valid-${index + 1}` }, noCtx))
      ]

      const exits = yield* collectBatched(creates, 5)
      const tags = exits.map(failureTag)
      expect(tags.filter((tag) => tag === "ValidationError").length).toBe(1)
      expect(tags.filter((tag) => tag === undefined).length).toBe(5)

      yield* waitForBatches(1)
      const snapshot = yield* stats.snapshot
      expect(snapshot.admitted).toBe(5)
      expect(snapshot.applied).toBe(5)
      expect(yield* countPosts).toBe(5)
    }).pipe(Effect.provide(batchedLayer()))
  )

  it.effect("isolates a statement-level unique-constraint failure inside one batch", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE UNIQUE INDEX "posts_title_unique" ON "posts" ("title")`)
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const exits = yield* collectBatched([
        svc.create(Posts, { title: "same" }, noCtx),
        svc.create(Posts, { title: "same" }, noCtx),
        svc.create(Posts, { title: "other" }, noCtx)
      ])

      const tags = exits.map(failureTag)
      expect(tags.filter((tag) => tag === undefined).length).toBe(2)
      expect(tags.filter((tag) => tag === "SqlError").length).toBe(1)
      expect(yield* countPosts).toBe(2)

      yield* waitForBatches(1)
      const snapshot = yield* stats.snapshot
      expect(snapshot.batches).toBe(1)
      expect(snapshot.commits).toBe(1)
    }).pipe(Effect.provide(batchedLayer()))
  )

  it.effect("fails the whole batch with the original cause when a statement rollback kills the transaction", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`
        CREATE TRIGGER "posts_poison" BEFORE INSERT ON "posts"
        WHEN NEW."title" = 'poison'
        BEGIN
          SELECT RAISE(ROLLBACK, 'poison');
        END
      `)
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const exits = yield* collectBatched([
        svc.create(Posts, { title: "ok-1" }, noCtx),
        svc.create(Posts, { title: "poison" }, noCtx),
        svc.create(Posts, { title: "ok-2" }, noCtx)
      ])

      // The entry's own cause is captured before the driver's savepoint
      // finalizer dies, so the batch normalizes to the real SQL error (a 500),
      // not a `BatchMutationClosedError` 503.
      const tags = exits.map(failureTag)
      expect(tags).toEqual(["SqlError", "SqlError", "SqlError"])
      expect(yield* countPosts).toBe(0)

      const snapshot = yield* stats.snapshot
      expect(snapshot.commits).toBe(0)
      expect(snapshot.batches).toBe(0)
    }).pipe(Effect.provide(batchedLayer()))
  )

  it.effect("transaction probe: RAISE(ROLLBACK) is dead, a statement constraint is alive", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE UNIQUE INDEX "posts_title_unique" ON "posts" ("title")`)
      yield* sql.unsafe(`
        CREATE TRIGGER "posts_poison" BEFORE INSERT ON "posts"
        WHEN NEW."title" = 'poison'
        BEGIN
          SELECT RAISE(ROLLBACK, 'poison');
        END
      `)
      yield* sql.unsafe(`INSERT INTO "posts" ("id", "title", "created", "updated") VALUES ('seed', 'dup', 'x', 'x')`)

      const dead = yield* Ref.make(Option.none<boolean>())
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* Effect.exit(
              sql`INSERT INTO "posts" ("id", "title", "created", "updated") VALUES ('poison', 'poison', 'x', 'x')`
            )
            yield* Ref.set(dead, Option.some(yield* probeTransactionAlive(sql)))
            // Leave the (already rolled back) transaction: the driver skips
            // ROLLBACK when `isTransaction` is false.
            return yield* Effect.fail(new ProbeAbort())
          })
        )
        .pipe(Effect.exit)
      expect(Option.getOrUndefined(yield* Ref.get(dead))).toBe(false)

      const alive = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* Effect.exit(
            sql`INSERT INTO "posts" ("id", "title", "created", "updated") VALUES ('dupe', 'dup', 'x', 'x')`
          )
          return yield* probeTransactionAlive(sql)
        })
      )
      expect(alive).toBe(true)
    }).pipe(Effect.provide(batcherOnlyLayer()))
  )

  it.effect("windowMs 0 drains without sleeping (virtual clock, no flushNow)", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      // Under `it.effect` time only moves when the TestClock is advanced. A
      // positive window here would hang, so this asserts the zero-window path
      // never sleeps.
      const row = yield* svc.create(Posts, { title: "zero-window" }, noCtx)
      expect(row["title"]).toBe("zero-window")

      yield* waitForBatches(1)
      const snapshot = yield* stats.snapshot
      expect(snapshot.batches).toBe(1)
      expect(snapshot.commits).toBe(1)
    }).pipe(Effect.provide(batchedLayer([Posts], withQueue(batchedConfig, { windowMs: 0 }))))
  )

  it.live("windowMs 0 keeps a sequential create closer to the inline path than a positive window", () =>
    Effect.gen(function* () {
      const medianMs = (samples: ReadonlyArray<number>) => {
        const sorted = [...samples].sort((left, right) => left - right)
        return sorted[Math.floor(sorted.length / 2)] ?? 0
      }

      const measure = (windowMs: number) =>
        Effect.gen(function* () {
          yield* setupPostsTable
          const svc = yield* CollectionService
          const samples: Array<number> = []
          for (let index = 0; index < 7; index += 1) {
            const startedAt = yield* Clock.currentTimeMillis
            yield* svc.create(Posts, { title: `seq-${windowMs}-${index}` }, noCtx)
            samples.push((yield* Clock.currentTimeMillis) - startedAt)
          }
          return medianMs(samples)
        }).pipe(Effect.provide(batchedLayer([Posts], withQueue(batchedConfig, { windowMs }))))

      const zeroWindow = yield* measure(0)
      const positiveWindow = yield* measure(5)

      // A positive window is a real timer (~15.6 ms on Windows); the zero-delay
      // path must be materially cheaper. The ratio keeps this robust to machine
      // speed.
      expect(zeroWindow).toBeLessThan(positiveWindow * 0.8)
    }).pipe(Effect.provide(Layer.empty))
  )

  it.live("uses windowMs 0 by default (no positive sleep per create)", () =>
    Effect.gen(function* () {
      const buildApp = (windowMs: number) =>
        Mira.builder()
          .platform(NodePlatform)
          .database(SqliteDatabase({ filename: ":memory:" }))
          .storage(LocalFileStorage({ directory: `./tmp/test-batch-default-${windowMs}` }))
          .collections([Posts])
          .rules([postsRules])
          .cache({ enabled: false })
          .batchMutation({ create: { windowMs } })
          .telemetry(Layer.empty)
          .build()

      const measure = (windowMs: number) =>
        Effect.gen(function* () {
          const svc = yield* CollectionService
          const samples: Array<number> = []
          for (let index = 0; index < 5; index += 1) {
            const startedAt = yield* Clock.currentTimeMillis
            yield* svc.create(Posts, { title: `default-${windowMs}-${index}` }, noCtx)
            samples.push((yield* Clock.currentTimeMillis) - startedAt)
          }
          return samples
        }).pipe(Effect.provide(buildApp(windowMs).buildServiceLayer()))

      const sortedMedian = (samples: ReadonlyArray<number>) => {
        const sorted = [...samples].sort((left, right) => left - right)
        return sorted[Math.floor(sorted.length / 2)] ?? 0
      }

      // The app default is `windowMs: 0`; a positive window is a real timer.
      // Compare against an explicit 5 ms window instead of an absolute bound
      // so the test stays meaningful on a loaded machine.
      const defaultMedian = sortedMedian(yield* measure(0))
      const positiveMedian = sortedMedian(yield* measure(5))
      expect(defaultMedian).toBeLessThan(positiveMedian * 0.8)
    })
  )

  it.effect("createMany bypasses the queue and stays all-or-nothing", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const rows = yield* svc.createMany(Posts, [{ title: "a" }, { title: "b" }, { title: "c" }], noCtx)
      expect(rows.map((row) => row["title"])).toEqual(["a", "b", "c"])
      const snapshot = yield* stats.snapshot
      expect(snapshot.admitted).toBe(0)
      expect(snapshot.batches).toBe(0)

      const failing = yield* svc.createMany(Posts, [{ title: "ok" }, {}], noCtx).pipe(Effect.exit)
      expect(failureTag(failing)).toBe("ValidationError")
      expect(yield* countPosts).toBe(3)
    }).pipe(Effect.provide(batchedLayer()))
  )

  it.effect("rejects create from inside an open SQL transaction", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const sql = yield* SqlClient.SqlClient

      const result = yield* sql
        .withTransaction(svc.create(Posts, { title: "nested" }, noCtx))
        .pipe(Effect.exit)
      expect(failureTag(result)).toBe("BatchMutationNestedTransactionError")
    }).pipe(Effect.provide(batchedLayer()))
  )
})

// ---------------------------------------------------------------------------
// Admission, timeouts and defects
// ---------------------------------------------------------------------------

describe("create batching queue bounds", () => {
  it.effect("rejects when the entry-count budget is full and releases it afterwards", () =>
    Effect.gen(function* () {
      const stats = yield* BatchMutationStats
      const batcher = yield* MutationBatcher
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()

      const held = yield* Effect.forkChild(
        batcher.submit({
          operation: "create",
          collection: Posts,
          execute: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ value: { id: "held" }, afterCommit: Effect.void })
          ),
          estimatedBytes: 10
        })
      )
      yield* waitForAdmitted(1)
      yield* stats.flushNow
      // The flusher has taken `held`, so the queue capacity is free even
      // though the insert is still running.
      yield* Deferred.await(started)

      const queued = yield* Effect.forkChild(
        batcher.submit({
          operation: "create",
          collection: Posts,
          execute: Effect.succeed({ value: { id: "queued" }, afterCommit: Effect.void }),
          estimatedBytes: 10
        })
      )
      yield* waitForAdmitted(2)

      const rejected = yield* batcher
        .submit({
          operation: "create",
          collection: Posts,
          execute: Effect.succeed({ value: { id: "rejected" }, afterCommit: Effect.void }),
          estimatedBytes: 10
        })
        .pipe(Effect.exit)
      expect(failureTag(rejected)).toBe("BatchMutationQueueFullError")

      yield* Deferred.succeed(gate, undefined)
      yield* stats.flushNow

      const heldRow = yield* Fiber.join(held)
      const queuedRow = yield* Fiber.join(queued)
      expect(heldRow["id"]).toBe("held")
      expect(queuedRow["id"]).toBe("queued")

      const snapshot = yield* stats.snapshot
      expect(snapshot.rejected).toBe(1)
    }).pipe(Effect.provide(batcherOnlyLayer(withQueue(batchedConfig, { maxQueueSize: 1 }))))
  )

  it.effect("rejects when the byte budget is full", () =>
    Effect.gen(function* () {
      const stats = yield* BatchMutationStats
      const batcher = yield* MutationBatcher
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()

      const held = yield* Effect.forkChild(
        batcher.submit({
          operation: "create",
          collection: Posts,
          execute: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ value: { id: "held" }, afterCommit: Effect.void })
          ),
          estimatedBytes: 1_000
        })
      )
      yield* waitForAdmitted(1)
      yield* stats.flushNow
      yield* Deferred.await(started)

      const queued = yield* Effect.forkChild(
        batcher.submit({
          operation: "create",
          collection: Posts,
          execute: Effect.succeed({ value: { id: "queued" }, afterCommit: Effect.void }),
          estimatedBytes: 600
        })
      )
      yield* waitForAdmitted(2)

      const rejected = yield* batcher
        .submit({
          operation: "create",
          collection: Posts,
          execute: Effect.succeed({ value: { id: "rejected" }, afterCommit: Effect.void }),
          estimatedBytes: 600
        })
        .pipe(Effect.exit)
      expect(failureTag(rejected)).toBe("BatchMutationQueueFullError")

      yield* Deferred.succeed(gate, undefined)
      yield* stats.flushNow
      yield* Fiber.join(held)
      yield* Fiber.join(queued)

      const snapshot = yield* stats.snapshot
      expect(snapshot.rejected).toBe(1)
    }).pipe(
      Effect.provide(batcherOnlyLayer(withQueue(batchedConfig, { maxQueueBytes: 1_000 })))
    )
  )

  it.live("times out a create whose batch never flushes and frees its budget", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const stats = yield* BatchMutationStats
      const svc = yield* CollectionService

      const timedOut = yield* svc.create(Posts, { title: "timeout" }, noCtx).pipe(Effect.exit)
      expect(failureTag(timedOut)).toBe("BatchMutationTimeoutError")

      // Drain the cancelled entry: the flusher skips it, so no row is written
      // and the queue budget is released. `records` counts written rows only.
      yield* stats.flushNow
      yield* waitFor("batches", 1, stats.snapshot.pipe(Effect.map((snapshot) => snapshot.batches)))
      expect((yield* stats.snapshot).applied).toBe(0)
      expect((yield* stats.snapshot).timedOut).toBe(1)
      expect((yield* stats.snapshot).rejected).toBe(0)
      expect(yield* countPosts).toBe(0)

      // `maxQueueSize: 1` proves the budget was released: this create is
      // admitted rather than rejected.
      const after = yield* Effect.forkChild(svc.create(Posts, { title: "after" }, noCtx))
      yield* waitForAdmitted(2)
      yield* stats.flushNow
      const row = yield* Fiber.join(after)
      expect(row["title"]).toBe("after")
    }).pipe(
      Effect.provide(
        batchedLayer([Posts], withQueue(batchedConfig, { windowMs: 60_000, submitTimeoutMs: 100, maxQueueSize: 1 }))
      )
    )
  )

  it.effect("a stats failure after COMMIT does not change the request outcome", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      // `recordFlush` dies after the commit and after the deferreds are
      // completed. The row exists, so the request must succeed.
      const committed = yield* collectBatched([svc.create(Posts, { title: "one" }, noCtx)])
      expect(failureTag(committed[0])).toBeUndefined()
      expect(Exit.isSuccess(committed[0]) ? committed[0].value["title"] : undefined).toBe("one")
      expect(yield* countPosts).toBe(1)

      yield* waitForCommits(1)
      const snapshot = yield* stats.snapshot
      expect(snapshot.commits).toBe(1)
      // The flush counter never recorded; that is a counter gap, not a 503.
      expect(snapshot.batches).toBe(0)
      // A stats failure is not a flusher defect.
      expect(snapshot.consecutiveDefects).toBe(0)

      const recovered = yield* collectBatched([svc.create(Posts, { title: "two" }, noCtx)])
      expect(failureTag(recovered[0])).toBeUndefined()
      expect(yield* countPosts).toBe(2)
    }).pipe(
      Effect.provide(batchedLayer([Posts], batchedConfig, makeInstrumentedStatsLayer({ failFlushTimes: 1 })))
    )
  )

  it.effect("maps a deferred foreign key COMMIT abort to a conflict and recovers", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "parents" ("id" TEXT PRIMARY KEY)`)
      yield* sql.unsafe(`DELETE FROM "parents"`)
      yield* sql.unsafe(`PRAGMA foreign_keys = ON`)
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      // The insert succeeds; the deferred FK violation only fires at COMMIT,
      // which the driver raises with `Effect.orDie`. A constraint defect is a
      // client-data conflict, not a batcher defect.
      const first = yield* collectBatched([
        svc.create(Posts, { title: "fk-1", parentId: "missing" }, noCtx),
        svc.create(Posts, { title: "fk-2", parentId: "missing" }, noCtx)
      ])
      expect(first.every((exit) => failureTag(exit) === "BatchMutationConflictError")).toBe(true)
      expect(yield* countPosts).toBe(0)
      expect((yield* stats.snapshot).consecutiveDefects).toBe(0)

      const recovered = yield* collectBatched([svc.create(Posts, { title: "after" }, noCtx)])
      expect(failureTag(recovered[0])).toBeUndefined()
      yield* waitForBatches(1)
      expect((yield* stats.snapshot).consecutiveDefects).toBe(0)
    }).pipe(Effect.provide(batchedLayer()))
  )

  it.effect("does not close the batcher after three consecutive deferred-FK conflicts", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS "parents" ("id" TEXT PRIMARY KEY)`)
      yield* sql.unsafe(`DELETE FROM "parents"`)
      yield* sql.unsafe(`PRAGMA foreign_keys = ON`)
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const failBatch = (title: string) => svc.create(Posts, { title, parentId: "missing" }, noCtx)

      for (const title of ["one", "two", "three"]) {
        const exits = yield* collectBatched([failBatch(title)])
        expect(failureTag(exits[0])).toBe("BatchMutationConflictError")
      }

      const recovered = yield* collectBatched([svc.create(Posts, { title: "four" }, noCtx)])
      expect(failureTag(recovered[0])).toBeUndefined()
      expect((yield* stats.snapshot).consecutiveDefects).toBe(0)
      expect((yield* countPosts)).toBe(1)
    }).pipe(Effect.provide(batchedLayer()))
  )

  it.effect("records one commit per create when batching is disabled", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      yield* svc.create(Posts, { title: "a" }, noCtx)
      yield* svc.create(Posts, { title: "b" }, noCtx)
      yield* svc.create(Posts, { title: "c" }, noCtx)

      const snapshot = yield* stats.snapshot
      expect(snapshot.inlineCommits).toBe(3)
      expect(snapshot.commits).toBe(0)
      expect(snapshot.batches).toBe(0)
      expect(snapshot.applied).toBe(0)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          serviceDeps(makeCollectionServiceLayer([Posts])),
          makeBatchMutationStatsLayer(),
          sqliteLayer,
          FileStorageTest,
          NodeCryptoLayer
        )
      )
    )
  )
})

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("create batcher shutdown", () => {
  it.effect("fails queued and in-flight uncommitted creates with BatchMutationClosedError", () =>
    Effect.gen(function* () {
      const statsLayer = makeBatchMutationStatsLayer()
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(batcherOnlyLayer(batchedConfig, statsLayer), scope)

      yield* Effect.gen(function* () {
        const stats = yield* BatchMutationStats
        const batcher = yield* MutationBatcher

        const queued = yield* Effect.forkChild(
          batcher.submit({
            operation: "create",
            collection: Posts,
            execute: Effect.never,
            estimatedBytes: 10
          })
        )
        yield* waitForAdmitted(1)
        // Shut down while the entry is still queued (no flush was signalled).
        yield* Scope.close(scope, Exit.void)
        const exit = yield* Fiber.await(queued)
        expect(failureTag(exit)).toBe("BatchMutationClosedError")
        expect((yield* stats.snapshot).applied).toBe(0)
      }).pipe(Effect.provide(context))

      // A consumer layer that depends on the batcher is released before it, so
      // the batcher's shutdown cannot race a live consumer.
      const consumerScope = yield* Scope.make()
      const releases: Array<string> = []
      const consumer = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* MutationBatcher
          yield* Effect.addFinalizer(() => Effect.sync(() => releases.push("consumer")))
        })
      )
      yield* Layer.buildWithScope(
        consumer.pipe(Layer.provide(batcherOnlyLayer(batchedConfig, makeBatchMutationStatsLayer()))),
        consumerScope
      )
      yield* Scope.close(consumerScope, Exit.void)
      expect(releases).toEqual(["consumer"])
    }))

  it.effect("rolls back an in-flight uncommitted create and reports BatchMutationClosedError", () =>
    Effect.gen(function* () {
      const statsLayer = makeBatchMutationStatsLayer()
      const scope = yield* Scope.make()
      // The SQL client is provided *outside* the batcher scope so the row can
      // be counted after shutdown.
      const context = yield* Layer.buildWithScope(
        Layer.merge(makeMutationBatcherLayer(batchedConfig, statsLayer), statsLayer),
        scope
      )

      yield* Effect.gen(function* () {
        yield* setupPostsTable
        const stats = yield* BatchMutationStats
        const batcher = yield* MutationBatcher
        const sql = yield* SqlClient.SqlClient
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()

        const inflight = yield* Effect.forkChild(
          batcher.submit({
            operation: "create",
            collection: Posts,
            execute: sql`INSERT INTO "posts" ("id", "title", "published", "created", "updated") VALUES ('inflight', 'inflight', 0, 'x', 'x')`.pipe(
              // A real write inside the open batch transaction, then block so
              // shutdown interrupts the transaction with the row uncommitted.
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ value: { id: "inflight" }, afterCommit: Effect.void })
            ),
            estimatedBytes: 10
          })
        )
        yield* waitForAdmitted(1)
        yield* stats.flushNow
        yield* Deferred.await(started)

        yield* Scope.close(scope, Exit.void)
        const exit = yield* Fiber.await(inflight)
        expect(failureTag(exit)).toBe("BatchMutationClosedError")
        expect((yield* stats.snapshot).commits).toBe(0)
        expect(yield* countPosts).toBe(0)
      }).pipe(Effect.provide(context))
    }).pipe(Effect.provide(sqliteLayer))
  )
})

/** Real batcher exposed as an output, for tests that submit entries directly. */
function batcherOnlyLayer(
  config: ResolvedBatchMutationConfig = batchedConfig,
  statsLayer: Layer.Layer<BatchMutationStats> = makeBatchMutationStatsLayer()
) {
  return Layer.merge(
    makeMutationBatcherLayer(config, statsLayer).pipe(Layer.provideMerge(sqliteLayer)),
    statsLayer
  )
}

describe("create batcher commit boundary", () => {
  it.effect("does not turn a committed row into a 503 when shutdown interrupts settlement", () =>
    Effect.gen(function* () {
      const commitSignal = yield* Deferred.make<void>()
      const statsLayer = makeInstrumentedStatsLayer({ commitSignal })
      const scope = yield* Scope.make()
      const layer = Layer.mergeAll(
        serviceDeps(makeBatchedCollectionServiceLayer([Posts], batchedConfig, statsLayer)),
        statsLayer,
        sqliteLayer
      )
      const context = yield* Layer.buildWithScope(layer, scope)

      yield* Effect.gen(function* () {
        yield* setupPostsTable
        const stats = yield* BatchMutationStats
        const svc = yield* CollectionService

        const create = yield* Effect.forkChild(svc.create(Posts, { title: "committed" }, noCtx))
        yield* waitForAdmitted(1)
        yield* stats.flushNow
        // `recordCommit` runs after COMMIT returns and before the deferred is
        // completed; close the scope exactly in that window.
        yield* Deferred.await(commitSignal)
        expect(yield* countPosts).toBe(1)
        yield* Scope.close(scope, Exit.void)

        const exit = yield* Fiber.await(create)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) expect(exit.value["title"]).toBe("committed")
      }).pipe(Effect.provide(context))
    })
  )
})

// ---------------------------------------------------------------------------
// Security: per-entry admin flag and hidden fields
// ---------------------------------------------------------------------------

describe("create batching security invariants", () => {
  it.effect("strips hidden fields per entry in a mixed admin/non-admin batch", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const svc = yield* CollectionService

      const exits = yield* collectBatched([
        svc.create(Users, { email: "anon@x.com", password: "secret", passwordConfirm: "secret" }, noCtx),
        svc.create(Users, { email: "admin@x.com", password: "secret" }, adminCtx)
      ])

      const anon = exits[0]
      const admin = exits[1]
      expect(Exit.isSuccess(anon)).toBe(true)
      expect(Exit.isSuccess(admin)).toBe(true)
      if (Exit.isSuccess(anon)) {
        expect(anon.value["email"]).toBe("anon@x.com")
        expect("password" in anon.value).toBe(false)
      }
      if (Exit.isSuccess(admin)) {
        expect(admin.value["email"]).toBe("admin@x.com")
        // Admin responses keep hidden fields; the non-admin one above lost its
        // password hash. Stripping is per entry, never batch-wide.
        expect("password" in admin.value).toBe(true)
      }
    }).pipe(Effect.provide(batchedLayer([Users])))
  )

  it.effect("hashes auth passwords before they enter the queue", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const sql = yield* SqlClient.SqlClient
      const svc = yield* CollectionService

      yield* collectBatched([
        svc.create(Users, { email: "hash@x.com", password: "secret", passwordConfirm: "secret" }, noCtx)
      ])

      const rows = yield* sql<{ password: string }>`SELECT "password" FROM ${sql("users")}`
      const stored = rows[0]?.password ?? ""
      expect(stored).not.toBe("secret")
      expect(stored.length).toBeGreaterThan(20)
    }).pipe(Effect.provide(batchedLayer([Users])))
  )
})

// ---------------------------------------------------------------------------
// Decorators: cache + hooks
// ---------------------------------------------------------------------------

describe("create batching with decorators", () => {
  it.effect("invalidates the list cache after a batched create", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const before = yield* svc.list(Posts, null, 10, noCtx)
      expect(before.items.length).toBe(0)

      yield* collectBatched([svc.create(Posts, { title: "cached" }, noCtx)])

      const after = yield* svc.list(Posts, null, 10, noCtx)
      expect(after.items.map((item) => item["title"])).toEqual(["cached"])
      yield* waitForBatches(1)
      expect((yield* stats.snapshot).batches).toBe(1)
    }).pipe(
      Effect.provide(
        (() => {
          const statsLayer = makeBatchMutationStatsLayer()
          const service = serviceDeps(
            makeCachedCollectionServiceLayer([Posts], {}, { batchMutation: batchedConfig, statsLayer })
          )
          return Layer.mergeAll(service, statsLayer, sqliteLayer, FileStorageTest, NodeCryptoLayer)
        })()
      )
    )
  )

  it.effect("runs pre/execute/success hooks once per batched request", () =>
    Effect.gen(function* () {
      const pre = yield* Ref.make(0)
      const success = yield* Ref.make(0)

      const plugin = MiraPlugin.define({
        onRecordCreate: {
          handler: (ctx) =>
            Ref.update(pre, (count) => count + 1).pipe(
              Effect.as({ ...ctx, data: { ...ctx.data, title: `hooked-${String(ctx.data["title"])}` } })
            )
        },
        onRecordCreateSuccess: {
          handler: () =>
            Ref.update(success, (count) => count + 1).pipe(Effect.asVoid)
        }
      })

      yield* Effect.gen(function* () {
        yield* setupPostsTable
        const svc = yield* CollectionService

        const exits = yield* collectBatched([
          svc.create(Posts, { title: "a" }, noCtx),
          svc.create(Posts, { title: "b" }, noCtx)
        ])
        expect(exits.every(Exit.isSuccess)).toBe(true)
        expect(
          exits.map((exit) => (Exit.isSuccess(exit) ? exit.value["title"] : undefined))
        ).toEqual(["hooked-a", "hooked-b"])
        expect(yield* Ref.get(pre)).toBe(2)
        yield* waitFor("success hooks", 2, Ref.get(success))
        expect(yield* Ref.get(success)).toBe(2)
      }).pipe(
        Effect.provide(
          (() => {
            const statsLayer = makeBatchMutationStatsLayer()
            const inner = serviceDeps(makeBatchedCollectionServiceLayer([Posts], batchedConfig, statsLayer))
            return Layer.mergeAll(
              makeHookCollectionServiceLayer().pipe(
                Layer.provide(Layer.mergeAll(inner, makeHookServiceLayer([plugin])))
              ),
              statsLayer,
              sqliteLayer,
              FileStorageTest,
              NodeCryptoLayer
            )
          })()
        )
      )
    })
  )
})

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

describe("create batching instrumentation", () => {
  it.effect("uses the delete access fast path and skips viewFilter/delete", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      const tracer = makeConsoleTracer(queue, (size) => randomBytes(size))
      const service = serviceDeps(makeCollectionServiceLayer([Posts]))

      yield* Effect.gen(function* () {
        yield* setupPostsTable
        const svc = yield* CollectionService
        const [row] = yield* svc.createMany(Posts, [{ title: "fast-delete" }], noCtx)
        yield* Queue.clear(queue)
        yield* svc.delete(Posts, String(row?.["id"]), noCtx)
        const spans = yield* Queue.clear(queue)

        expect(spans.some((span) => span.name === "repository.viewWithAccess")).toBe(true)
        expect(spans.some((span) => span.name === "repository.deleteExisting")).toBe(true)
        expect(spans.some((span) => span.name === "repository.viewFilter")).toBe(false)
        expect(spans.some((span) => span.name === "repository.delete")).toBe(false)
      }).pipe(
        Effect.provide(Layer.mergeAll(service, sqliteLayer, FileStorageTest, NodeCryptoLayer)),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    })
  )

  it.effect("emits a batch span with size and per-entry insert spans", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      const tracer = makeConsoleTracer(queue, (size) => randomBytes(size))
      const statsLayer = makeBatchMutationStatsLayer()
      const service = serviceDeps(makeBatchedCollectionServiceLayer([Posts], batchedConfig, statsLayer))

      yield* Effect.gen(function* () {
        yield* setupPostsTable
        const svc = yield* CollectionService
        yield* collectBatched([
          svc.create(Posts, { title: "span-a" }, noCtx),
          svc.create(Posts, { title: "span-b" }, noCtx)
        ])
        const spans = yield* Queue.clear(queue)

        const batch = spans.find((span) => span.name === "collection.mutationBatch")
        expect(batch).toBeDefined()
        expect(batch?.attributes["batch.size"]).toBe(2)
        expect(batch?.attributes["batch.collectionCount"]).toBe(1)
        expect(batch?.attributes["batch.collections"]).toBe("posts")
        expect(spans.filter((span) => span.name === "collection.mutateInBatch").length).toBe(2)
      }).pipe(
        // The flusher is forked during layer construction, so the custom tracer
        // must be in context *before* the layer is built.
        Effect.provide(Layer.mergeAll(service, statsLayer, sqliteLayer, FileStorageTest, NodeCryptoLayer)),
        Effect.provideService(Tracer.Tracer, tracer)
      )
    })
  )
})

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

describe("MiraApp create batching wiring", () => {
  it.live("serves creates through the batched base when .batchMutation() enables create", () =>
    Effect.gen(function* () {
      const app = Mira.builder()
        .platform(NodePlatform)
        .database(SqliteDatabase({ filename: ":memory:" }))
        .storage(LocalFileStorage({ directory: "./tmp/test-batch-app" }))
        .collections([Posts])
        .rules([postsRules])
        .cache({ enabled: false })
        .batchMutation({ create: { windowMs: 1 } })
        .telemetry(Layer.empty)
        .build()

      yield* Effect.gen(function* () {
        const svc = yield* CollectionService
        const stats = yield* BatchMutationStats
        const row = yield* svc.create(Posts, { title: "wired" }, noCtx)
        expect(row["title"]).toBe("wired")

        yield* waitForBatches(1)
        const snapshot = yield* stats.snapshot
        expect(snapshot.admitted).toBe(1)
        expect(snapshot.commits).toBe(1)
        expect(snapshot.batches).toBe(1)
      }).pipe(Effect.provide(app.buildServiceLayer()))
    })
  )

  it.live("exposes BatchMutationStats even when batching is disabled", () =>
    Effect.gen(function* () {
      const app = Mira.builder()
        .platform(NodePlatform)
        .database(SqliteDatabase({ filename: ":memory:" }))
        .storage(LocalFileStorage({ directory: "./tmp/test-batch-app-off" }))
        .collections([Posts])
        .rules([postsRules])
        .cache({ enabled: false })
        .telemetry(Layer.empty)
        .build()

      yield* Effect.gen(function* () {
        const svc = yield* CollectionService
        const stats = yield* BatchMutationStats
        yield* svc.create(Posts, { title: "inline" }, noCtx)

        const snapshot = yield* stats.snapshot
        expect(snapshot.inlineCommits).toBe(1)
        expect(snapshot.commits).toBe(0)
        expect(snapshot.batches).toBe(0)
        expect(snapshot.admitted).toBe(0)
      }).pipe(Effect.provide(app.buildServiceLayer()))
    })
  )

  it.live("wires the batched base through the cached path when .cache() is enabled", () =>
    Effect.gen(function* () {
      const app = Mira.builder()
        .platform(NodePlatform)
        .database(SqliteDatabase({ filename: ":memory:" }))
        .storage(LocalFileStorage({ directory: "./tmp/test-batch-app-cache" }))
        .collections([Posts])
        .rules([postsRules])
        .cache({ enabled: true })
        .batchMutation({ create: {} })
        .telemetry(Layer.empty)
        .build()

      yield* Effect.gen(function* () {
        const svc = yield* CollectionService
        const stats = yield* BatchMutationStats
        const row = yield* svc.create(Posts, { title: "cached-wired" }, noCtx)
        expect(row["title"]).toBe("cached-wired")

        yield* waitForBatches(1)
        const snapshot = yield* stats.snapshot
        expect(snapshot.admitted).toBe(1)
        expect(snapshot.commits).toBe(1)
        expect(snapshot.batches).toBe(1)
      }).pipe(Effect.provide(app.buildServiceLayer()))
    })
  )
})

// ---------------------------------------------------------------------------
// Update/delete batching
// ---------------------------------------------------------------------------

describe("update/delete batching", () => {
  it.effect("batches 20 concurrent updates and reports per-operation stats", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const seeded = yield* svc.createMany(
        Posts,
        Array.from({ length: 20 }, (_, index) => ({ title: `seed-${index}` })),
        noCtx
      )
      const ids = seeded.map((row) => String(row["id"]))

      const exits = yield* collectBatched(
        ids.map((id, index) => svc.update(Posts, id, { title: `updated-${index}` }, noCtx))
      )
      expect(exits.every((exit) => Exit.isSuccess(exit))).toBe(true)
      yield* waitForOperationApplied("update", 20)

      const snapshot = yield* stats.snapshot
      expect(snapshot.operations.update.applied).toBe(20)
      expect(snapshot.operations.update.batches).toBeGreaterThanOrEqual(1)
      expect(snapshot.commits).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(batchedLayer([Posts], mutationConfig)))
  )

  it.effect("fails only the missing update id", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const seeded = yield* svc.createMany(
        Posts,
        Array.from({ length: 19 }, (_, index) => ({ title: `seed-${index}` })),
        noCtx
      )
      const ids = seeded.map((row) => String(row["id"]))

      const exits = yield* collectBatched([
        ...ids.map((id, index) => svc.update(Posts, id, { title: `updated-${index}` }, noCtx)),
        svc.update(Posts, "missing-id", { title: "missing" }, noCtx)
      ])

      expect(exits.filter((exit) => Exit.isSuccess(exit)).length).toBe(19)
      expect(failureTag(exits[19])).toBe("NotFoundError")
      yield* waitForOperationApplied("update", 19)
      const snapshot = yield* stats.snapshot
      expect(snapshot.operations.update.applied).toBe(19)
    }).pipe(Effect.provide(batchedLayer([Posts], mutationConfig)))
  )

  it.effect("returns 404 for anonymous auth-requiring delete of a missing row and 403 for an existing row", () =>
    Effect.gen(function* () {
      yield* setupGuardedTable
      const sql = yield* SqlClient.SqlClient
      const svc = yield* CollectionService
      yield* sql`INSERT INTO ${sql("guarded")} ("id", "title", "created", "updated") VALUES ('existing', 'x', 'now', 'now')`

      const missing = yield* svc.delete(Guarded, "missing", noCtx).pipe(Effect.exit)
      expect(failureTag(missing)).toBe("NotFoundError")

      const denied = yield* svc.delete(Guarded, "existing", noCtx).pipe(Effect.exit)
      expect(failureTag(denied)).toBe("ForbiddenError")

      yield* svc.delete(Guarded, "existing", adminCtx)
    }).pipe(Effect.provide(batchedLayer([Guarded])))
  )

  it.effect("falls back for a delete rule with a body placeholder and does not substitute a column", () =>
    Effect.gen(function* () {
      yield* setupBodyGuardedTable
      const sql = yield* SqlClient.SqlClient
      const svc = yield* CollectionService
      yield* sql`INSERT INTO ${sql("body_guarded")} ("id", "title", "created", "updated") VALUES ('existing', 'x', 'now', 'now')`

      const denied = yield* svc.delete(BodyGuarded, "existing", noCtx).pipe(Effect.exit)
      expect(failureTag(denied)).toBe("ForbiddenError")

      const stillThere = yield* sql<{ id: string }>`SELECT "id" FROM ${sql("body_guarded")} WHERE "id" = 'existing'`
      expect(stillThere.length).toBe(1)

      yield* svc.delete(BodyGuarded, "existing", adminCtx)
    }).pipe(Effect.provide(batchedLayer([BodyGuarded])))
  )

  it.effect("reads the stored row inside the batch and returns 404 when it vanished", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats
      const sql = yield* SqlClient.SqlClient

      const [row] = yield* svc.createMany(Posts, [{ title: "vanishing" }], noCtx)
      const id = String(row?.["id"])
      const fiber = yield* Effect.forkChild(
        svc.update(Posts, id, { title: "updated" }, noCtx).pipe(Effect.exit)
      )
      yield* waitForAdmitted(1)
      // The row disappears after admission but before the flush executes.
      yield* sql`DELETE FROM ${sql("posts")} WHERE "id" = ${id}`
      yield* stats.flushNow

      const exit = yield* Fiber.join(fiber)
      expect(failureTag(exit)).toBe("NotFoundError")
      expect((yield* stats.snapshot).admitted).toBe(1)
    }).pipe(Effect.provide(batchedLayer([Posts], mutationConfig)))
  )

  it.effect("batches 20 concurrent deletes and removes every row", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const seeded = yield* svc.createMany(
        Posts,
        Array.from({ length: 20 }, (_, index) => ({ title: `seed-${index}` })),
        noCtx
      )
      const ids = seeded.map((row) => String(row["id"]))

      const exits = yield* collectBatched(ids.map((id) => svc.delete(Posts, id, noCtx)))
      expect(exits.every((exit) => Exit.isSuccess(exit))).toBe(true)
      expect(yield* countPosts).toBe(0)
      yield* waitForOperationApplied("delete", 20)

      const snapshot = yield* stats.snapshot
      expect(snapshot.operations.delete.applied).toBe(20)
      expect(snapshot.operations.delete.batches).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(batchedLayer([Posts], mutationConfig)))
  )

  it.effect("fails only the missing delete id", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const stats = yield* BatchMutationStats

      const seeded = yield* svc.createMany(
        Posts,
        Array.from({ length: 19 }, (_, index) => ({ title: `seed-${index}` })),
        noCtx
      )
      const ids = seeded.map((row) => String(row["id"]))

      const exits = yield* collectBatched([
        ...ids.map((id) => svc.delete(Posts, id, noCtx)),
        svc.delete(Posts, "missing-id", noCtx)
      ])

      expect(exits.filter((exit) => Exit.isSuccess(exit)).length).toBe(19)
      expect(failureTag(exits[19])).toBe("NotFoundError")
      yield* waitForOperationApplied("delete", 19)
      const snapshot = yield* stats.snapshot
      expect(snapshot.operations.delete.applied).toBe(19)
    }).pipe(Effect.provide(batchedLayer([Posts], mutationConfig)))
  )

  it.effect("orders update then delete of the same row in one flush", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService

      const [row] = yield* svc.createMany(Posts, [{ title: "ordered" }], noCtx)
      const id = String(row?.["id"])
      const exits = yield* collectBatched([
        svc.update(Posts, id, { title: "updated" }, noCtx),
        svc.delete(Posts, id, noCtx)
      ])

      expect(exits.every((exit) => Exit.isSuccess(exit))).toBe(true)
      expect(yield* countPosts).toBe(0)
    }).pipe(Effect.provide(batchedLayer([Posts], mutationConfig)))
  )
})
