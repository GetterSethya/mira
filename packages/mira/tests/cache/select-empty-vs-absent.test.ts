import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
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
// Regression tests: an empty select/expand (`[]`) must NOT share a cache key
// with an absent one (`undefined`/`null`). `[].join(",")` is `""`, identical
// to the absent case, so without a sentinel the second read is poisoned by
// the first read's cached response (in either order).
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
      "author"  TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "posts"`)
})

// Seed one author + one post; returns the post id. Service creates nuke the
// list cache, so each test starts with a cold list cache and a fresh record.
const seedPost = Effect.gen(function* () {
  const svc = yield* CollectionService
  const author = yield* svc.create(Authors, { name: "Alice" }, noCtx)
  const authorId: unknown = author["id"]
  if (typeof authorId !== "string") return yield* Effect.die("seedPost: expected string author id")
  const post = yield* svc.create(Posts, { title: "Hello", body: "world", author: authorId }, noCtx)
  const postId: unknown = post["id"]
  if (typeof postId !== "string") return yield* Effect.die("seedPost: expected string post id")
  return postId
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sortedKeys(record: Record<string, unknown>): Array<string> {
  return Object.keys(record).sort()
}

const SYSTEM_KEYS = ["created", "id", "updated"]
const FULL_KEYS = ["author", "body", "created", "id", "title", "updated"]
const SELECT_EXPAND_KEYS = ["author", "created", "expand", "id", "title", "updated"]
const SELECT_NO_EXPAND_KEYS = ["created", "id", "title", "updated"]

describe("cached select/expand key separation (empty vs absent)", () => {
  it.effect("view select=[] then no-select returns the full record", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const narrowed = yield* svc.view(Posts, postId, noCtx, [], null)
      if (!isRecord(narrowed)) return yield* Effect.die("expected record")
      expect(sortedKeys(narrowed)).toEqual(SYSTEM_KEYS)
      const full = yield* svc.view(Posts, postId, noCtx)
      if (!isRecord(full)) return yield* Effect.die("expected record")
      expect(sortedKeys(full)).toEqual(FULL_KEYS)
      expect(full["title"]).toBe("Hello")
    }).pipe(Effect.provide(testLayer)))

  it.effect("view no-select then select=[] returns system fields only", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const full = yield* svc.view(Posts, postId, noCtx)
      if (!isRecord(full)) return yield* Effect.die("expected record")
      expect(sortedKeys(full)).toEqual(FULL_KEYS)
      const narrowed = yield* svc.view(Posts, postId, noCtx, [], null)
      if (!isRecord(narrowed)) return yield* Effect.die("expected record")
      expect(sortedKeys(narrowed)).toEqual(SYSTEM_KEYS)
    }).pipe(Effect.provide(testLayer)))

  it.effect("view select+expand then select+expand=[] keeps them distinct", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const expanded = yield* svc.view(Posts, postId, noCtx, ["title"], ["author"])
      if (!isRecord(expanded)) return yield* Effect.die("expected record")
      expect(sortedKeys(expanded)).toEqual(SELECT_EXPAND_KEYS)
      const unexpanded = yield* svc.view(Posts, postId, noCtx, ["title"], [])
      if (!isRecord(unexpanded)) return yield* Effect.die("expected record")
      expect(sortedKeys(unexpanded)).toEqual(SELECT_NO_EXPAND_KEYS)
    }).pipe(Effect.provide(testLayer)))

  it.effect("view select+expand=[] then select+expand keeps them distinct", () =>
    Effect.gen(function* () {
      yield* setupTables
      const postId = yield* seedPost
      const svc = yield* CollectionService
      const unexpanded = yield* svc.view(Posts, postId, noCtx, ["title"], [])
      if (!isRecord(unexpanded)) return yield* Effect.die("expected record")
      expect(sortedKeys(unexpanded)).toEqual(SELECT_NO_EXPAND_KEYS)
      const expanded = yield* svc.view(Posts, postId, noCtx, ["title"], ["author"])
      if (!isRecord(expanded)) return yield* Effect.die("expected record")
      expect(sortedKeys(expanded)).toEqual(SELECT_EXPAND_KEYS)
      const expandValue: unknown = expanded["expand"]
      if (!isRecord(expandValue)) return yield* Effect.die("expected expand object")
      const authorValue: unknown = expandValue["author"]
      if (!isRecord(authorValue)) return yield* Effect.die("expected expanded author record")
      expect(authorValue["name"]).toBe("Alice")
    }).pipe(Effect.provide(testLayer)))

  it.effect("list select=[] then no-select returns full items", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const narrowed = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, [], null)
      expect(narrowed.items.length).toBe(1)
      const narrowedItem = narrowed.items[0]
      if (!isRecord(narrowedItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(narrowedItem)).toEqual(SYSTEM_KEYS)
      const full = yield* svc.list(Posts, null, 10, noCtx)
      expect(full.items.length).toBe(1)
      const fullItem = full.items[0]
      if (!isRecord(fullItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(fullItem)).toEqual(FULL_KEYS)
    }).pipe(Effect.provide(testLayer)))

  it.effect("list no-select then select=[] returns system-only items", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const full = yield* svc.list(Posts, null, 10, noCtx)
      const fullItem = full.items[0]
      if (!isRecord(fullItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(fullItem)).toEqual(FULL_KEYS)
      const narrowed = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, [], null)
      const narrowedItem = narrowed.items[0]
      if (!isRecord(narrowedItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(narrowedItem)).toEqual(SYSTEM_KEYS)
    }).pipe(Effect.provide(testLayer)))

  it.effect("list select+expand then select+expand=[] keeps them distinct", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const expanded = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, ["title"], ["author"])
      const expandedItem = expanded.items[0]
      if (!isRecord(expandedItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(expandedItem)).toEqual(SELECT_EXPAND_KEYS)
      const unexpanded = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, ["title"], [])
      const unexpandedItem = unexpanded.items[0]
      if (!isRecord(unexpandedItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(unexpandedItem)).toEqual(SELECT_NO_EXPAND_KEYS)
    }).pipe(Effect.provide(testLayer)))

  it.effect("list select+expand=[] then select+expand keeps them distinct", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedPost
      const svc = yield* CollectionService
      const unexpanded = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, ["title"], [])
      const unexpandedItem = unexpanded.items[0]
      if (!isRecord(unexpandedItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(unexpandedItem)).toEqual(SELECT_NO_EXPAND_KEYS)
      const expanded = yield* svc.list(Posts, null, 10, noCtx, undefined, undefined, ["title"], ["author"])
      const expandedItem = expanded.items[0]
      if (!isRecord(expandedItem)) return yield* Effect.die("expected record item")
      expect(sortedKeys(expandedItem)).toEqual(SELECT_EXPAND_KEYS)
    }).pipe(Effect.provide(testLayer)))
})
