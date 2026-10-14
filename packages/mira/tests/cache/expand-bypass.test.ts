import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCachedCollectionServiceLayer } from "@/cache/cached-collection.js"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"

// ---------------------------------------------------------------------------
// Regression tests: a request carrying a non-empty `expand` must bypass the
// cache entirely.
//
// A cached list/view response can embed expanded target rows whose own `view`
// rule is resolved from the request `ctx` (attached to the LEFT JOIN's ON
// clause by `resolveExpand`). `buildCtxCacheTag` only captures the *source*
// collection's rule refs, so two requests differing only in a ctx key the
// *target* rule reads would otherwise share one cache key — letting a cached
// expanded payload be replayed to a caller the target rule denies.
// ---------------------------------------------------------------------------

const authorsDef = BaseCollection.define("authors", {
  name: Field.text(),
  tenant: Field.text(),
})
const authorsRules = defineRule(authorsDef, (R) => ({
  list: R.public(),
  // The target rule of a post→author expand is bound by the request's `tenant`
  // query key, which the *source* (posts) cache tag never captures.
  view: R.field("tenant").eq(R.request("query", "tenant")),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))
const Authors = applyRulesToCollections([authorsDef], [authorsRules])[0]

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
  body: Field.text({ required: false }),
  author: Field.relation(authorsDef),
})
const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))
const Posts = applyRulesToCollections([postsDef], [postsRules])[0]

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
const DialectTest = Layer.succeed(Dialect, sqliteDialect)

const cachedServiceWithDeps = makeCachedCollectionServiceLayer([Authors, Posts], {
  recordTtlMs: 60_000,
  listTtlMs: 60_000,
  maxRecords: 100,
  maxLists: 100,
}).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)

const testLayer = Layer.mergeAll(cachedServiceWithDeps, sqliteLayer, FileStorageTest, NodeCryptoLayer)

const noCtx: RequestCtx = { headers: {}, query: {} }

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "authors" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "name"    TEXT NOT NULL,
      "tenant"  TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("authors")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "body"    TEXT,
      "author"  TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("posts")}`
})

/** Seed one author + one post; returns the post id. Service creates nuke the list cache. */
const seedPost = Effect.gen(function* () {
  const svc = yield* CollectionService
  const author = yield* svc.create(Authors, { name: "Alice", tenant: "t1" }, noCtx)
  const authorId: unknown = author["id"]
  if (typeof authorId !== "string") return yield* Effect.die("seedPost: expected string author id")
  const post = yield* svc.create(Posts, { title: "Hello", body: "world", author: authorId }, noCtx)
  const postId: unknown = post["id"]
  if (typeof postId !== "string") return yield* Effect.die("seedPost: expected string post id")
  return postId
})

describe("expanded reads bypass the cache", () => {
  it.effect("view with a non-empty expand sees an out-of-band update (no cache hit)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const sql = yield* SqlClient.SqlClient

      const first = yield* svc.view(Posts, postId, noCtx, ["title"], ["author"])
      expect(first["title"]).toBe("Hello")

      // Mutate out-of-band so no cache invalidation runs. A cached response would
      // keep returning the original title.
      yield* sql`UPDATE ${sql("posts")} SET title = ${"Hello-v2"} WHERE id = ${postId}`

      const second = yield* svc.view(Posts, postId, noCtx, ["title"], ["author"])
      expect(second["title"]).toBe("Hello-v2")
    }).pipe(Effect.provide(testLayer)))

  it.effect("list with a non-empty expand sees an out-of-band insert (no cache hit)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const sql = yield* SqlClient.SqlClient

      // Prime the (source-only) plain list cache with one row.
      const plainFirst = yield* svc.list(Posts, null, 10, noCtx)
      expect(plainFirst.items.length).toBe(1)

      // An expanded list must consult the DB rather than reuse the cached page.
      const expandedFirst = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, undefined, ["author"])
      expect(expandedFirst.items.length).toBe(1)

      const now = "2026-01-01T00:00:00.000Z"
      yield* sql`INSERT INTO ${sql("posts")} (id, title, created, updated) VALUES (${"direct-id"}, ${"Direct"}, ${now}, ${now})`

      // The plain list is still served from cache (stale)...
      const plainSecond = yield* svc.list(Posts, null, 10, noCtx)
      expect(plainSecond.items.length).toBe(1)

      // ...while the expanded list observes the new row.
      const expandedSecond = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, undefined, ["author"])
      expect(expandedSecond.items.length).toBe(2)
    }).pipe(Effect.provide(testLayer)))

  it.effect("an empty expand array still caches (empty vs absent stays distinct)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const sql = yield* SqlClient.SqlClient

      const first = yield* svc.view(Posts, postId, noCtx, ["title"], [])
      expect(first["title"]).toBe("Hello")

      yield* sql`UPDATE ${sql("posts")} SET title = ${"Hello-v2"} WHERE id = ${postId}`

      const second = yield* svc.view(Posts, postId, noCtx, ["title"], [])
      expect(second["title"]).toBe("Hello")
    }).pipe(Effect.provide(testLayer)))

  it.effect("a target-rule ctx key cannot leak an expanded row across requests", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService

      const allowed: RequestCtx = { headers: {}, query: { tenant: "t1" } }
      const denied: RequestCtx = { headers: {}, query: { tenant: "t2" } }

      // The author is inside tenant t1, so only the t1 requester's expand matches.
      const allowedView = yield* svc.view(Posts, postId, allowed, ["title"], ["author"])
      const allowedExpand = allowedView["expand"]
      expect(allowedExpand).toBeDefined()

      // The posts view rule is public, so — absent the expand bypass — both requests
      // would share the `public` cache tag and t2 would replay t1's expanded author.
      const deniedView = yield* svc.view(Posts, postId, denied, ["title"], ["author"])
      expect(deniedView["expand"]).toBeUndefined()
    }).pipe(Effect.provide(testLayer)))
})
