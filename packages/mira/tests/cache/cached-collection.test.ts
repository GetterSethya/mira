import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Either, Layer } from "effect"
import { performance } from "node:perf_hooks"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { ViewCollection } from "@gettersethya/mira-client"
import { Rule } from "@gettersethya/mira-client"
import { CollectionService } from "@/collection-service/collection-service.js"
import { NotFoundError } from "@/collection-service/errors.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { makeCachedCollectionServiceLayer } from "@/cache/cached-collection.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { NodeCryptoLayer } from "@/crypto/node.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 100 }),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

// Intentionally slow view: 100 000-step recursive CTE forces SQLite to do
// significant work on every query, making the cache speedup clearly measurable.
// SUM(n) requires visiting all 100 000 rows — SQLite cannot short-circuit it.
const SLOW_SQL = `
WITH RECURSIVE gen(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM gen WHERE n < 100000)
SELECT 1 AS seqId, 'perf-test-id' AS id, CAST(SUM(n) AS TEXT) AS title FROM gen`

const SlowView = ViewCollection.define("slow_posts", SLOW_SQL.trim(), {
  seqId: Field.integer().view(),
  id: Field.text().view(),
  title: Field.text().view(),
}).rules((R) => ({ list: R.public(), view: R.public() }))

const noCtx: RequestCtx = { headers: {}, query: {} }

const FileStorageTest = Layer.succeed(
  FileStorage,
  FileStorage.of({
    upload: (key) => Effect.succeed(key),
    delete: () => Effect.void,
    url: (key) => `/files/${key}`,
    read: (key) => Effect.fail(new FileStorageNotFound({ key })),
    exists: () => Effect.succeed(false),
    list: () => Effect.succeed([]),
  })
)

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const perfSqliteLayer = SqliteClient.layer({ filename: ":memory:" })

const cachedServiceWithDeps = makeCachedCollectionServiceLayer([Posts], {
  recordTtlMs: 60_000,
  listTtlMs: 60_000,
  maxRecords: 100,
  maxLists: 100,
}).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer)
)

// Expose CollectionService AND SqlClient so setupPostsTable can access SqlClient.SqlClient
const testLayer = Layer.mergeAll(cachedServiceWithDeps, sqliteLayer, FileStorageTest, NodeCryptoLayer)

const perfCachedServiceWithDeps = makeCachedCollectionServiceLayer([Posts, SlowView], {
  recordTtlMs: 60_000,
  listTtlMs: 60_000,
  maxRecords: 100,
  maxLists: 100,
}).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(perfSqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer)
)

const perfTestLayer = Layer.mergeAll(perfCachedServiceWithDeps, perfSqliteLayer, FileStorageTest, NodeCryptoLayer)

const setupPostsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "posts"`)
})

const setupPerfView = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // posts table required by the layer even though SlowView doesn't query it
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DROP VIEW IF EXISTS "slow_posts"`)
  // This view is intentionally bad: the 100 000-step CTE forces SQLite to do
  // real work on every query execution. SUM(n) requires all rows — no early exit.
  yield* sql.unsafe(`
    CREATE VIEW "slow_posts" AS
    WITH RECURSIVE gen(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM gen WHERE n < 100000)
    SELECT 1 AS seqId, 'perf-test-id' AS id, CAST(SUM(n) AS TEXT) AS title FROM gen
  `)
})

describe("CachedCollectionService", () => {
  it.effect("view cache hit — second view returns cached value after row deleted from DB", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const sql = yield* SqlClient.SqlClient

      const created = yield* svc.create(Posts, { title: "Cached" }, noCtx)
      const id = created["id"] as string

      // First view — populates cache
      const first = yield* svc.view(Posts, id, noCtx)
      expect(first["title"]).toBe("Cached")

      // Delete row directly from DB (bypassing service, so no cache invalidation)
      yield* sql.unsafe(`DELETE FROM "posts" WHERE id = ?`, [id])

      // Second view — should still return cached value
      const second = yield* svc.view(Posts, id, noCtx)
      expect(second["title"]).toBe("Cached")
    }).pipe(Effect.provide(testLayer)))

  it.effect("view cache invalidated by update — returns updated record", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService

      const created = yield* svc.create(Posts, { title: "Original" }, noCtx)
      const id = created["id"] as string

      // Prime the cache
      yield* svc.view(Posts, id, noCtx)

      // Update via service — invalidates cache
      yield* svc.update(Posts, id, { title: "Updated" }, noCtx)

      // View should now return the updated record
      const result = yield* svc.view(Posts, id, noCtx)
      expect(result["title"]).toBe("Updated")
    }).pipe(Effect.provide(testLayer)))

  it.effect("view cache invalidated by delete — returns NotFoundError", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService

      const created = yield* svc.create(Posts, { title: "ToDelete" }, noCtx)
      const id = created["id"] as string

      // Prime the cache
      yield* svc.view(Posts, id, noCtx)

      // Delete via service — invalidates cache
      yield* svc.delete(Posts, id, noCtx)

      // View should fail with NotFoundError
      const result = yield* Effect.either(svc.view(Posts, id, noCtx))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left instanceof NotFoundError).toBe(true)
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("list cache hit — second list returns cached count after direct DB insert", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const sql = yield* SqlClient.SqlClient

      yield* svc.create(Posts, { title: "A" }, noCtx)
      yield* svc.create(Posts, { title: "B" }, noCtx)

      // First list — populates cache
      const first = yield* svc.list(Posts, null, 10, noCtx)
      expect(first.items.length).toBe(2)

      // Insert a row directly into DB (bypassing service, so no cache invalidation)
      yield* sql.unsafe(
        `INSERT INTO "posts" (id, title, created, updated) VALUES ('direct-id', 'Direct', datetime('now'), datetime('now'))`
      )

      // Second list — should return cached result (still 2)
      const second = yield* svc.list(Posts, null, 10, noCtx)
      expect(second.items.length).toBe(2)
    }).pipe(Effect.provide(testLayer)))

  it.effect("list cache invalidated by create — returns updated count", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService

      yield* svc.create(Posts, { title: "A" }, noCtx)
      yield* svc.create(Posts, { title: "B" }, noCtx)

      // Prime the list cache
      const first = yield* svc.list(Posts, null, 10, noCtx)
      expect(first.items.length).toBe(2)

      // Create via service — invalidates list cache
      yield* svc.create(Posts, { title: "C" }, noCtx)

      // List should now show 3 records
      const second = yield* svc.list(Posts, null, 10, noCtx)
      expect(second.items.length).toBe(3)
    }).pipe(Effect.provide(testLayer)))

  it.effect("list cache invalidated by update — returns updated record in list", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService

      const created = yield* svc.create(Posts, { title: "Before" }, noCtx)
      const id = created["id"] as string

      // Prime the list cache
      const first = yield* svc.list(Posts, null, 10, noCtx)
      expect(first.items[0]?.["title"]).toBe("Before")

      // Update via service — invalidates list cache
      yield* svc.update(Posts, id, { title: "After" }, noCtx)

      // List should reflect the update
      const second = yield* svc.list(Posts, null, 10, noCtx)
      expect(second.items[0]?.["title"]).toBe("After")
    }).pipe(Effect.provide(testLayer)))

  it.effect("list cache invalidated by delete — record no longer in list", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService

      const r1 = yield* svc.create(Posts, { title: "Keep" }, noCtx)
      const r2 = yield* svc.create(Posts, { title: "Remove" }, noCtx)
      const id2 = r2["id"] as string

      // Prime the list cache
      const first = yield* svc.list(Posts, null, 10, noCtx)
      expect(first.items.length).toBe(2)

      // Delete via service — invalidates list cache
      yield* svc.delete(Posts, id2, noCtx)

      // List should now show 1 record
      const second = yield* svc.list(Posts, null, 10, noCtx)
      expect(second.items.length).toBe(1)
      const titles = second.items.map((r) => r["title"])
      expect(titles).toContain("Keep")
      expect(titles).not.toContain("Remove")
    }).pipe(Effect.provide(testLayer)))
})

describe("Performance — cache vs. DB", () => {
  // Each test uses a fresh :memory: DB and empty cache via perfTestLayer.
  // slow_posts VIEW forces 100 000 recursive CTE steps + full SUM aggregation
  // on every cold query; the cached path skips all SQL entirely.

  it.effect("list: cache hit is significantly faster than the intentionally slow DB query", () =>
    Effect.gen(function* () {
      yield* setupPerfView
      const svc = yield* CollectionService

      // Cold call — runs 100 000-step CTE, populates list cache
      const t0 = performance.now()
      const page = yield* svc.list(SlowView, null, 10, noCtx)
      const dbMs = performance.now() - t0

      // Warm call — served entirely from in-memory HashMap
      const t1 = performance.now()
      yield* svc.list(SlowView, null, 10, noCtx)
      const cacheMs = performance.now() - t1

      console.log(
        `  [perf/list]  DB: ${dbMs.toFixed(2)} ms  |  cache: ${cacheMs.toFixed(2)} ms  |  speedup: ${(dbMs / Math.max(cacheMs, 0.01)).toFixed(0)}×`
      )

      expect(page.items.length).toBe(1)
      // DB query must have taken measurable time — proves the slow SQL actually ran
      expect(dbMs).toBeGreaterThan(2)
      // Cache must be at least 5× faster than the DB
      expect(cacheMs * 5).toBeLessThan(dbMs)
    }).pipe(Effect.provide(perfTestLayer)))

  it.effect("view: cache hit is significantly faster than the intentionally slow DB query", () =>
    Effect.gen(function* () {
      yield* setupPerfView
      const svc = yield* CollectionService

      // Cold call — SQLite re-evaluates the CTE to resolve the view, populates record cache
      const t0 = performance.now()
      const record = yield* svc.view(SlowView, "perf-test-id", noCtx)
      const dbMs = performance.now() - t0

      // Warm call — served entirely from in-memory HashMap
      const t1 = performance.now()
      yield* svc.view(SlowView, "perf-test-id", noCtx)
      const cacheMs = performance.now() - t1

      console.log(
        `  [perf/view]  DB: ${dbMs.toFixed(2)} ms  |  cache: ${cacheMs.toFixed(2)} ms  |  speedup: ${(dbMs / Math.max(cacheMs, 0.01)).toFixed(0)}×`
      )

      expect(record["id"]).toBe("perf-test-id")
      // DB query must have taken measurable time — proves the slow SQL actually ran
      expect(dbMs).toBeGreaterThan(2)
      // Cache must be at least 5× faster than the DB
      expect(cacheMs * 5).toBeLessThan(dbMs)
    }).pipe(Effect.provide(perfTestLayer)))
})
