/**
 * Telemetry demo: watch structured logs and span traces in action.
 *
 * Run:
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/telemetry-demo-script.ts
 *
 * What you will see:
 *   {"level":"INFO","message":"...","timestamp":"..."}           ← structured log lines
 *   [trace] {"span":"cache.list","traceId":"...","cache.hit":false,...}  ← span lines
 *
 * Output order per request (cache miss):
 *   cache.view / cache.list  (outermost — root)
 *   collection.view / collection.list  (child)
 *   repository.*  (innermost — leaf)
 *
 * On cache hits only the cache.* span appears (no children).
 */

import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Logger, LogLevel } from "effect"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { RepositoryLive } from "@/repository/repository.js"
import { CollectionService } from "@/collection-service/collection-service.js"
import { makeCachedCollectionServiceLayer } from "@/cache/cached-collection.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ConsoleTelemetryLayer } from "@/telemetry/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import type { RequestCtx } from "@/collection-service/context.js"

// ---------------------------------------------------------------------------
// Collection definition
// ---------------------------------------------------------------------------

const Posts = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 200 }),
  published: Field.boolean({ default: false })
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const noCtx: RequestCtx = { headers: {}, query: {} }

// ---------------------------------------------------------------------------
// Stub FileStorage (no uploads in this demo)
// ---------------------------------------------------------------------------

const FileStorageStub = Layer.succeed(
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

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const repoLayer = RepositoryLive.pipe(Layer.provide(Layer.merge(sqliteLayer, NodeCryptoLayer)))

const serviceLayer = makeCachedCollectionServiceLayer([Posts], {
  recordTtlMs: 60_000,
  listTtlMs: 60_000,
  maxRecords: 1_000,
  maxLists: 200
}).pipe(Layer.provide(repoLayer), Layer.provide(sqliteLayer), Layer.provide(FileStorageStub))

const appLayer = Layer.mergeAll(serviceLayer, sqliteLayer, FileStorageStub, ConsoleTelemetryLayer).pipe(
  Layer.provideMerge(NodeCryptoLayer)
)

// ---------------------------------------------------------------------------
// Demo program
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const svc = yield* CollectionService

  // --- Setup: create the posts table ----------------------------------------
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"     INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"        TEXT NOT NULL UNIQUE,
      "title"     TEXT NOT NULL DEFAULT '',
      "published" INTEGER NOT NULL DEFAULT 0,
      "created"   TEXT NOT NULL,
      "updated"   TEXT NOT NULL
    )
  `)

  // --- Create ---------------------------------------------------------------
  yield* Effect.logInfo("=== CREATE: two posts ===")
  const p1 = yield* svc.create(Posts, { title: "Hello Effect" }, noCtx)
  const p2 = yield* svc.create(Posts, { title: "Telemetry rocks" }, noCtx)
  yield* Effect.logInfo(`Created: ${p1["id"] as string}, ${p2["id"] as string}`)

  // --- List (cache miss) ----------------------------------------------------
  yield* Effect.logInfo("=== LIST (cache miss — full span chain) ===")
  const page1 = yield* svc.list(Posts, null, 10, noCtx)
  yield* Effect.logInfo(`Listed ${page1.items.length} posts, nextCursor=${String(page1.nextCursor)}`)

  // --- List (cache hit) -----------------------------------------------------
  yield* Effect.logInfo("=== LIST (cache hit — only cache.list span) ===")
  const page2 = yield* svc.list(Posts, null, 10, noCtx)
  yield* Effect.logInfo(`Listed ${page2.items.length} posts (from cache)`)

  // --- View (cache miss) ----------------------------------------------------
  const id1 = p1["id"] as string
  yield* Effect.logInfo("=== VIEW (cache miss) ===")
  yield* svc.view(Posts, id1, noCtx)
  yield* Effect.logInfo(`Viewed post ${id1}`)

  // --- View (cache hit) -----------------------------------------------------
  yield* Effect.logInfo("=== VIEW (cache hit — only cache.view span) ===")
  yield* svc.view(Posts, id1, noCtx)
  yield* Effect.logInfo(`Viewed post ${id1} again (from cache)`)

  // --- Update ---------------------------------------------------------------
  yield* Effect.logInfo("=== UPDATE (invalidates cache) ===")
  yield* svc.update(Posts, id1, { title: "Hello Effect (edited)" }, noCtx)

  // --- Delete ---------------------------------------------------------------
  yield* Effect.logInfo("=== DELETE ===")
  yield* svc.delete(Posts, id1, noCtx)

  yield* Effect.logInfo("=== Done — check lines above for [trace] span output ===")
}).pipe(
  // Show all log levels including Debug so you see everything
  Logger.withMinimumLogLevel(LogLevel.Info)
)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

Effect.runPromise(program.pipe(Effect.provide(appLayer))).catch((err) => {
  console.error(err)
  process.exit(1)
})
