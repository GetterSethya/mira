import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import type { WithSelect } from "@gettersethya/mira-client"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { CollectionService, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"

// ---------------------------------------------------------------------------
// Collection definitions — posts has a hidden field and a relation to authors
// ---------------------------------------------------------------------------

const authorsDef = BaseCollection.define("authors", {
  name: Field.text(),
})
const authorsRules = defineRule(authorsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))
const Authors = applyRulesToCollections([authorsDef], [authorsRules])[0]

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
  body: Field.text({ required: false }),
  views: Field.integer({ default: 0 }),
  secret: Field.text({ hidden: true, required: false }),
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

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const FileStorageTest = Layer.succeed(FileStorage, FileStorage.of({
  upload: (key) => Effect.succeed(key),
  delete: () => Effect.void,
  url: (key) => `/files/${key}`,
  read: (key) => Effect.fail(new FileStorageNotFound({ key })),
  exists: () => Effect.succeed(false),
  list: () => Effect.succeed([]),
}))

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const DialectTest = Layer.succeed(Dialect, sqliteDialect)

const noCtx: RequestCtx = { headers: {}, query: {} }

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "authors" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "name"    TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "authors"`)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "body"    TEXT,
      "views"   INTEGER NOT NULL DEFAULT 0,
      "secret"  TEXT,
      "author"  TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "posts"`)
})

const collectionServiceWithDeps = makeCollectionServiceLayer([Authors, Posts]).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)
const testLayer = Layer.mergeAll(collectionServiceWithDeps, sqliteLayer, FileStorageTest, NodeCryptoLayer)

// Seed one author + one post (with a hidden `secret` value); returns the post id.
const seedPost = Effect.gen(function* () {
  const svc = yield* CollectionService
  const author = yield* svc.create(Authors, { name: "Alice" }, noCtx)
  const authorId: unknown = author["id"]
  if (typeof authorId !== "string") return yield* Effect.die("seedPost: expected string author id")
  const post = yield* svc.create(
    Posts,
    { title: "Hello", body: "world", views: 3, secret: "shh", author: authorId },
    noCtx
  )
  const postId: unknown = post["id"]
  if (typeof postId !== "string") return yield* Effect.die("seedPost: expected string post id")
  return postId
})

function sortedKeys(record: Record<string, unknown>): Array<string> {
  return Object.keys(record).sort()
}

// ---------------------------------------------------------------------------
// The narrowed result type for select: ["title"] + expand: ["author"].
// The runtime key assertions below are checked against this type so the
// response shape and the client type cannot drift apart.
// ---------------------------------------------------------------------------

type SelectedExpanded = keyof WithSelect<typeof Posts.fields, ["title"], ["author"]>
const selectedExpandedKeys: Array<SelectedExpanded> = ["author", "created", "expand", "id", "title", "updated"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

describe("select + expand response shape", () => {
  it.effect("list with select returns only selected + system fields", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const page = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, ["title"], null)
      expect(page.items.length).toBe(1)
      const item = page.items[0]
      if (!isRecord(item)) return yield* Effect.die("expected record item")
      expect(sortedKeys(item)).toEqual(["created", "id", "title", "updated"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("list with select + expand returns selected + system + local id + expand", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const page = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, ["title"], ["author"])
      expect(page.items.length).toBe(1)
      const item = page.items[0]
      if (!isRecord(item)) return yield* Effect.die("expected record item")
      // Exact key set matches the WithSelect<..., ["title"], ["author"]> type above.
      expect(sortedKeys(item)).toEqual([...selectedExpandedKeys].sort())
      const expandValue: unknown = item["expand"]
      if (!isRecord(expandValue)) return yield* Effect.die("expected expand object")
      const authorValue: unknown = expandValue["author"]
      if (!isRecord(authorValue)) return yield* Effect.die("expected expanded author record")
      expect(authorValue["name"]).toBe("Alice")
    }).pipe(Effect.provide(testLayer)))

  it.effect("view with select + expand matches the narrowed shape", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const record = yield* svc.view(Posts, postId, noCtx, ["title"], ["author"])
      if (!isRecord(record)) return yield* Effect.die("expected record")
      expect(sortedKeys(record)).toEqual([...selectedExpandedKeys].sort())
    }).pipe(Effect.provide(testLayer)))

  it.effect("list with empty select returns system fields only", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const page = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, [], null)
      expect(page.items.length).toBe(1)
      const item = page.items[0]
      if (!isRecord(item)) return yield* Effect.die("expected record item")
      expect(sortedKeys(item)).toEqual(["created", "id", "updated"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("hidden field is stripped without select and ignored when selected", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const full = yield* svc.list(Posts, null, 10, noCtx)
      const fullItem = full.items[0]
      if (!isRecord(fullItem)) return yield* Effect.die("expected record item")
      expect(fullItem["secret"]).toBeUndefined()
      const selected = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, ["title", "secret"], null)
      const selectedItem = selected.items[0]
      if (!isRecord(selectedItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(selectedItem)).toEqual(["created", "id", "title", "updated"])
    }).pipe(Effect.provide(testLayer)))
})
