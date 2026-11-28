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

import { SqlClient } from "effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, References, Schema } from "effect"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { defineRule, applyRulesToCollections } from "@/app/index.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { RepositoryLive } from "@/repository/repository.js"
import { CollectionService } from "@/collection-service/collection-service.js"
import { makeCachedCollectionServiceLayer } from "@/cache/cached-collection.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ConsoleTelemetryLayer } from "@/telemetry/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import type { RequestCtx } from "@/collection-service/context.js"

// ---------------------------------------------------------------------------
// Collection definition
// ---------------------------------------------------------------------------

const postsDef = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 200 }),
  published: Field.boolean({ default: false })
})

const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const [Posts] = applyRulesToCollections([postsDef], [postsRules])

const noCtx: RequestCtx = { headers: {}, query: {} }

const RecordId = Schema.Struct({ id: Schema.String })

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
const dialectLayer = Layer.succeed(Dialect, sqliteDialect)
const repoLayer = RepositoryLive.pipe(Layer.provide(Layer.merge(sqliteLayer, NodeCryptoLayer, dialectLayer)))

const serviceLayer = makeCachedCollectionServiceLayer([Posts], {
  recordTtlMs: 60_000,
  listTtlMs: 60_000,
  maxRecords: 1_000,
  maxLists: 200
}).pipe(
  Layer.provide(repoLayer),
  Layer.provide(sqliteLayer),
  Layer.provide(dialectLayer),
  Layer.provide(FileStorageStub),
  Layer.provide(NodeAuthServiceLayer)
)

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
  const { id: p1Id } = yield* Schema.decodeUnknownEffect(RecordId)(p1).pipe(Effect.orDie)
  const { id: p2Id } = yield* Schema.decodeUnknownEffect(RecordId)(p2).pipe(Effect.orDie)
  yield* Effect.logInfo(`Created: ${p1Id}, ${p2Id}`)

  // --- List (cache miss) ----------------------------------------------------
  yield* Effect.logInfo("=== LIST (cache miss — full span chain) ===")
  const page1 = yield* svc.list(Posts, null, 10, noCtx)
  yield* Effect.logInfo(`Listed ${page1.items.length} posts, nextCursor=${String(page1.nextCursor)}`)

  // --- List (cache hit) -----------------------------------------------------
  yield* Effect.logInfo("=== LIST (cache hit — only cache.list span) ===")
  const page2 = yield* svc.list(Posts, null, 10, noCtx)
  yield* Effect.logInfo(`Listed ${page2.items.length} posts (from cache)`)

  // --- View (cache miss) ----------------------------------------------------
  yield* Effect.logInfo("=== VIEW (cache miss) ===")
  yield* svc.view(Posts, p1Id, noCtx)
  yield* Effect.logInfo(`Viewed post ${p1Id}`)

  // --- View (cache hit) -----------------------------------------------------
  yield* Effect.logInfo("=== VIEW (cache hit — only cache.view span) ===")
  yield* svc.view(Posts, p1Id, noCtx)
  yield* Effect.logInfo(`Viewed post ${p1Id} again (from cache)`)

  // --- Update ---------------------------------------------------------------
  yield* Effect.logInfo("=== UPDATE (invalidates cache) ===")
  yield* svc.update(Posts, p1Id, { title: "Hello Effect (edited)" }, noCtx)

  // --- Delete ---------------------------------------------------------------
  yield* Effect.logInfo("=== DELETE ===")
  yield* svc.delete(Posts, p1Id, noCtx)

  yield* Effect.logInfo("=== Done — check lines above for [trace] span output ===")
}).pipe(Effect.provideService(References.MinimumLogLevel, "Info"))

// ---------------------------------------------------------------------------
// Launch the demo against the in-memory SQLite layer
// ---------------------------------------------------------------------------

Effect.runPromise(program.pipe(Effect.provide(appLayer))).catch((err) => {
  console.error(err)
  process.exit(1)
})
