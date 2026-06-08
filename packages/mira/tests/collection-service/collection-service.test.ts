import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Either, Layer, Match } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { AuthCollection, BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { ViewCollection } from "@gettersethya/mira-client"
import { Rule } from "@gettersethya/mira-client"
import { RepositoryLive } from "@/repository/repository.js"
import { CollectionService, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ForbiddenError, NotFoundError, ReadOnlyError, ValidationError } from "@/collection-service/errors.js"
import type { CursorPage, RequestCtx } from "@/collection-service/context.js"
import { NodeCryptoLayer } from "@/crypto/node.js"

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const FileStorageTest = Layer.succeed(FileStorage, FileStorage.of({
  upload: (key) => Effect.succeed(key),
  delete: () => Effect.void,
  url: (key) => `/files/${key}`,
  read: (key) => Effect.fail(new FileStorageNotFound({ key })),
  exists: () => Effect.succeed(false),
  list: () => Effect.succeed([])
}))

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

const collectionServiceWithDeps = makeCollectionServiceLayer([]).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer)
)

const testLayer = Layer.mergeAll(collectionServiceWithDeps, sqliteLayer, FileStorageTest, NodeCryptoLayer)

const noCtx: RequestCtx = { headers: {}, query: {} }

// ---------------------------------------------------------------------------
// Table setup helpers
// seqId as INTEGER PRIMARY KEY AUTOINCREMENT so SQLite fills it on INSERT.
// ---------------------------------------------------------------------------

const setupPostsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"     INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"        TEXT NOT NULL UNIQUE,
      "title"     TEXT NOT NULL,
      "published" INTEGER NOT NULL DEFAULT 0,
      "authorId"  TEXT,
      "created"   TEXT NOT NULL,
      "updated"   TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "posts"`)
})

// View collection tests: a base table + a SQLite VIEW over it
const setupViewTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts_base" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "status"  TEXT NOT NULL DEFAULT 'draft',
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "posts_base"`)
  yield* sql.unsafe(`DROP VIEW IF EXISTS "active_posts"`)
  yield* sql.unsafe(`
    CREATE VIEW "active_posts" AS
      SELECT seqId, id, title, status, created, updated FROM posts_base WHERE status = 'active'
  `)
})

const setupScoredTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "scored" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "name"    TEXT NOT NULL,
      "score"   REAL NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "scored"`)
})

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

// Base collection — all operations public
const Posts = BaseCollection.define("posts", {
  title: Field.text({ maxLength: 100 }),
  published: Field.boolean({ default: false }),
  authorId: Field.text({ required: false })
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

// Base collection — rule-enforced: only authorId "user1" can access
const ProtectedPosts = BaseCollection.define("posts", {
  title: Field.text(),
  published: Field.boolean({ default: false }),
  authorId: Field.text({ required: false })
}).rules((R) => ({
  list: R.field("authorId").eq(R.literal("user1")),
  view: R.field("authorId").eq(R.literal("user1")),
  create: R.field("authorId").eq(R.literal("user1")),
  update: R.field("authorId").eq(R.literal("user1")),
  delete: R.field("authorId").eq(R.literal("user1"))
}))

// Base collection — no rules (deny all by default)
const NoRulePosts = BaseCollection.define("posts", {
  title: Field.text()
})

// View collection — public list/view, no create/update/delete
const ActivePosts = ViewCollection.define(
  "active_posts",
  "SELECT seqId, id, title, status, created, updated FROM posts_base WHERE status = 'active'",
  {
    seqId:   Field.integer().view(),
    id:      Field.text().view(),
    title:   Field.text().view(),
    status:  Field.text().view()
  }
).rules((R) => ({
  list: R.public(),
  view: R.public()
}))

// Collection with error callbacks for integration testing
const Scored = BaseCollection.define("scored", {
  name: Field.text({
    minLength: 2,
    error: (kind) => Match.value(kind).pipe(
      Match.when("minLength", () => "Name too short"),
      Match.when("required",  () => "Name is required"),
      Match.orElse(()         => "Invalid name")
    )
  }),
  score: Field.number({
    min: 0,
    max: 100,
    error: (kind) => Match.value(kind).pipe(
      Match.when("minimum", () => "Score below zero"),
      Match.when("maximum", () => "Score above 100"),
      Match.orElse(()       => "Invalid score")
    )
  })
}).rules((R) => ({
  create: R.public(),
  update: R.public(),
  list:   R.public(),
  view:   R.public(),
  delete: R.public()
}))

// Collection with a literalText field
const Roles = BaseCollection.define("roles", {
  role: Field.literalText({ literal: ["admin", "agent", "readonly"] })
}).rules((R) => ({
  create: R.public(),
  update: R.public(),
  list:   R.public(),
  view:   R.public(),
  delete: R.public()
}))

// ScoredServiceLayer wires Scored into the collection service
const scoredServiceWithDeps = makeCollectionServiceLayer([Scored]).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer)
)
const scoredTestLayer = Layer.mergeAll(scoredServiceWithDeps, sqliteLayer, FileStorageTest, NodeCryptoLayer)

// RolesServiceLayer wires Roles into the collection service
const rolesServiceWithDeps = makeCollectionServiceLayer([Roles]).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer)
)
const rolesTestLayer = Layer.mergeAll(rolesServiceWithDeps, sqliteLayer, FileStorageTest, NodeCryptoLayer)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCursorPage(r: unknown): r is CursorPage {
  return typeof r === "object" && r !== null && "nextCursor" in r
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it.effect("public base collection returns CursorPage shape", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.list(Posts, null, 10, noCtx)
      expect(isCursorPage(result)).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("returns all inserted rows", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "A" }, noCtx)
      yield* svc.create(Posts, { title: "B" }, noCtx)
      const result = yield* svc.list(Posts, null, 10, noCtx)
      expect(isCursorPage(result) && result.items.length).toBe(2)
    }).pipe(Effect.provide(testLayer)))

  it.effect("seqId is NOT present in list items (x-hidden stripped)", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "X" }, noCtx)
      const result = yield* svc.list(Posts, null, 10, noCtx)
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect("seqId" in result.items[0]).toBe(false)
    }).pipe(Effect.provide(testLayer)))

  it.effect("nextCursor is null when page is not full", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "A" }, noCtx)
      const result = yield* svc.list(Posts, null, 10, noCtx)
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.nextCursor).toBeNull()
    }).pipe(Effect.provide(testLayer)))

  it.effect("nextCursor is a number when page is full", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "A" }, noCtx)
      yield* svc.create(Posts, { title: "B" }, noCtx)
      yield* svc.create(Posts, { title: "C" }, noCtx)
      const result = yield* svc.list(Posts, null, 2, noCtx)
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(typeof result.nextCursor).toBe("number")
    }).pipe(Effect.provide(testLayer)))

  it.effect("cursor pagination: page 2 fetches rows not in page 1", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "A" }, noCtx)
      yield* svc.create(Posts, { title: "B" }, noCtx)
      yield* svc.create(Posts, { title: "C" }, noCtx)
      yield* svc.create(Posts, { title: "D" }, noCtx)
      yield* svc.create(Posts, { title: "E" }, noCtx)

      const page1 = yield* svc.list(Posts, null, 2, noCtx)
      if (!isCursorPage(page1)) throw new Error("expected CursorPage")
      expect(page1.items.length).toBe(2)
      expect(page1.nextCursor).not.toBeNull()

      if (page1.nextCursor === null) throw new Error("expected nextCursor")
      const page2 = yield* svc.list(Posts, page1.nextCursor, 2, noCtx)
      if (!isCursorPage(page2)) throw new Error("expected CursorPage")
      expect(page2.items.length).toBe(2)

      if (page2.nextCursor === null) throw new Error("expected nextCursor")
      const page3 = yield* svc.list(Posts, page2.nextCursor, 2, noCtx)
      if (!isCursorPage(page3)) throw new Error("expected CursorPage")
      expect(page3.items.length).toBe(1)
      expect(page3.nextCursor).toBeNull()

      const ids1 = page1.items.map((r) => r["id"])
      const ids2 = page2.items.map((r) => r["id"])
      expect(ids1.some((id) => ids2.includes(id))).toBe(false)
    }).pipe(Effect.provide(testLayer)))

  it.effect("rule-enforced list returns only matching rows", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "Mine", authorId: "user1" }, noCtx)
      yield* svc.create(Posts, { title: "Theirs", authorId: "user2" }, noCtx)
      const result = yield* svc.list(ProtectedPosts, null, 10, noCtx)
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(1)
      expect(result.items[0]["title"]).toBe("Mine")
    }).pipe(Effect.provide(testLayer)))

  it.effect("no rules → ForbiddenError", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.list(NoRulePosts, null, 10, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
        if (result.left._tag === "ForbiddenError") {
          expect(result.left.action).toBe("list")
        }
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("view collection returns CursorPage shape", () =>
    Effect.gen(function* () {
      yield* setupViewTables
      const svc = yield* CollectionService
      const result = yield* svc.list(ActivePosts, null, 10, noCtx)
      expect(isCursorPage(result)).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("view collection list returns only rows from the view", () =>
    Effect.gen(function* () {
      yield* setupViewTables
      const sql = yield* SqlClient.SqlClient
      // Insert directly into posts_base since repository uses different table name
      yield* sql.unsafe(
        `INSERT INTO posts_base (id, title, status, created, updated) VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ["id1", "Active Post", "active"]
      )
      yield* sql.unsafe(
        `INSERT INTO posts_base (id, title, status, created, updated) VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
        ["id2", "Draft Post", "draft"]
      )
      const svc = yield* CollectionService
      const result = yield* svc.list(ActivePosts, null, 10, noCtx)
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(1)
      expect(result.items[0]["title"]).toBe("Active Post")
    }).pipe(Effect.provide(testLayer)))
})

// ---------------------------------------------------------------------------
// list with filter
// ---------------------------------------------------------------------------

describe("list with filter", () => {
  it.effect("filters by eq on string field", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "Apple" }, noCtx)
      yield* svc.create(Posts, { title: "Banana" }, noCtx)
      yield* svc.create(Posts, { title: "Apple Pie" }, noCtx)
      const result = yield* svc.list(Posts, null, 10, noCtx, {
        op: "like",
        field: "title",
        value: "Apple%"
      })
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(2)
    }).pipe(Effect.provide(testLayer)))

  it.effect("filters by gt on integer field", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "A", authorId: "10" }, noCtx)
      yield* svc.create(Posts, { title: "B", authorId: "20" }, noCtx)
      yield* svc.create(Posts, { title: "C", authorId: "30" }, noCtx)
      // authorId is text but we can still compare with gt textually
      const result = yield* svc.list(Posts, null, 10, noCtx, {
        op: "gt",
        field: "authorId",
        value: "20"
      })
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(1)
      expect(result.items[0]["title"]).toBe("C")
    }).pipe(Effect.provide(testLayer)))

  it.effect("and filter combines conditions", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "Alpha", authorId: "user1" }, noCtx)
      yield* svc.create(Posts, { title: "Beta", authorId: "user2" }, noCtx)
      yield* svc.create(Posts, { title: "Gamma", authorId: "user1" }, noCtx)
      // Filter: title starts with "A" AND authorId = "user1"
      // We can approximate startsWith using like
      const result = yield* svc.list(Posts, null, 10, noCtx, {
        op: "and",
        left: { op: "like", field: "title", value: "A%" },
        right: { op: "eq", field: "authorId", value: "user1" }
      })
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(1)
      expect(result.items[0]["title"]).toBe("Alpha")
    }).pipe(Effect.provide(testLayer)))

  it.effect("filter is ANDed with rule enforcement", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "X", authorId: "user1" }, noCtx)
      yield* svc.create(Posts, { title: "Y", authorId: "user1" }, noCtx)
      yield* svc.create(Posts, { title: "Z", authorId: "user2" }, noCtx)
      // ProtectedPosts rule: authorId = "user1"
      // Filter: title like "X" → should return only "X" (which is user1's)
      const result = yield* svc.list(ProtectedPosts, null, 10, noCtx, {
        op: "like",
        field: "title",
        value: "X"
      })
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(1)
      expect(result.items[0]["title"]).toBe("X")
    }).pipe(Effect.provide(testLayer)))

  it.effect("in filter works", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "Red" }, noCtx)
      yield* svc.create(Posts, { title: "Green" }, noCtx)
      yield* svc.create(Posts, { title: "Blue" }, noCtx)
      const result = yield* svc.list(Posts, null, 10, noCtx, {
        op: "in",
        field: "title",
        values: ["Red", "Blue"]
      })
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(2)
      const titles = result.items.map((r) => r["title"]).sort()
      expect(titles).toEqual(["Blue", "Red"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("or filter works", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "Cat", authorId: "a" }, noCtx)
      yield* svc.create(Posts, { title: "Dog", authorId: "b" }, noCtx)
      yield* svc.create(Posts, { title: "Fish", authorId: "c" }, noCtx)
      // title = "Cat" OR authorId = "b"
      const result = yield* svc.list(Posts, null, 10, noCtx, {
        op: "or",
        left: { op: "eq", field: "title", value: "Cat" },
        right: { op: "eq", field: "authorId", value: "b" }
      })
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(2)
      const titles = result.items.map((r) => r["title"]).sort()
      expect(titles).toEqual(["Cat", "Dog"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("not filter works", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      yield* svc.create(Posts, { title: "Keep" }, noCtx)
      yield* svc.create(Posts, { title: "Skip" }, noCtx)
      yield* svc.create(Posts, { title: "Keep2" }, noCtx)
      // NOT (title = "Skip")
      const result = yield* svc.list(Posts, null, 10, noCtx, {
        op: "not",
        node: { op: "eq", field: "title", value: "Skip" }
      })
      if (!isCursorPage(result)) throw new Error("expected CursorPage")
      expect(result.items.length).toBe(2)
      const titles = result.items.map((r) => r["title"])
      expect(titles).not.toContain("Skip")
    }).pipe(Effect.provide(testLayer)))
})

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe("view", () => {
  it.effect("returns the row for an existing id", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "Hello" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc.view(Posts, id, noCtx)
      expect(result["title"]).toBe("Hello")
    }).pipe(Effect.provide(testLayer)))

  it.effect("returns NotFoundError for an unknown id", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.view(Posts, "nonexistent123", noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotFoundError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("seqId is NOT in the returned row", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "Hidden" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc.view(Posts, id, noCtx)
      expect("seqId" in result).toBe(false)
    }).pipe(Effect.provide(testLayer)))

  it.effect("row not matching rule → NotFoundError (indistinguishable from missing)", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "Other", authorId: "user2" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc.view(ProtectedPosts, id, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotFoundError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("no rules → ForbiddenError", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.view(NoRulePosts, "any", noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
      }
    }).pipe(Effect.provide(testLayer)))
})

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("create", () => {
  it.effect("inserts a valid row and returns it with id, created, updated", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Posts, { title: "New Post" }, noCtx)
      expect(typeof result["id"]).toBe("string")
      expect(result["title"]).toBe("New Post")
      expect(typeof result["created"]).toBe("string")
      expect(typeof result["updated"]).toBe("string")
    }).pipe(Effect.provide(testLayer)))

  it.effect("seqId is NOT in the returned row", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Posts, { title: "X" }, noCtx)
      expect("seqId" in result).toBe(false)
    }).pipe(Effect.provide(testLayer)))

  it.effect("ValidationError when required field is missing", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Posts, { published: true }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
        if (result.left._tag === "ValidationError") {
          expect(result.left.issues.some((i) => i.includes("title"))).toBe(true)
        }
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("ValidationError when x-system field is in input", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Posts, { title: "X", id: "hacked" }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
        if (result.left._tag === "ValidationError") {
          expect(result.left.issues.some((i) => i.includes("id"))).toBe(true)
        }
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("ValidationError when seqId is in input", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Posts, { title: "X", seqId: 99 }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("ValidationError when type is wrong", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Posts, { title: 42 }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("ValidationError when string exceeds maxLength", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc
        .create(Posts, { title: "x".repeat(101) }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
        if (result.left._tag === "ValidationError") {
          expect(result.left.issues.some((i) => i.includes("100"))).toBe(true)
        }
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("ForbiddenError when create rule pre-check fails", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      // ProtectedPosts requires authorId = "user1"; supply "user2" → rule fails
      const result = yield* svc
        .create(ProtectedPosts, { title: "X", authorId: "user2" }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("create succeeds when rule pre-check passes", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(ProtectedPosts, { title: "X", authorId: "user1" }, noCtx)
      expect(result["title"]).toBe("X")
    }).pipe(Effect.provide(testLayer)))

  it.effect("no rules → ForbiddenError", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.create(NoRulePosts, { title: "X" }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("view collection → ReadOnlyError", () =>
    Effect.gen(function* () {
      yield* setupViewTables
      const svc = yield* CollectionService
      const result = yield* svc
        .create(ActivePosts, { id: "x", title: "X", status: "active" }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ReadOnlyError")
      }
    }).pipe(Effect.provide(testLayer)))
})

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("update", () => {
  it.effect("updates supplied fields, leaves others unchanged", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "Old", authorId: "user1" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const updated = yield* svc.update(Posts, id, { title: "New" }, noCtx)
      expect(updated["title"]).toBe("New")
      expect(updated["authorId"]).toBe("user1")
    }).pipe(Effect.provide(testLayer)))

  it.live("updated timestamp is refreshed; created is unchanged", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "Time" }, noCtx)
      yield* Effect.sleep(5)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const updated = yield* svc.update(Posts, id, { title: "Time2" }, noCtx)
      expect(updated["created"]).toBe(created["created"])
      expect(updated["updated"]).not.toBe(created["updated"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("ValidationError when x-system field is in patch", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "X" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc
        .update(Posts, id, { title: "Y", id: "hacked", created: "1970" }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("NotFoundError for unknown id", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc
        .update(Posts, "nosuchid1234567", { title: "X" }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotFoundError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("ForbiddenError when rule blocks update", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      // Insert row with authorId user2 using public Posts, then try to update via ProtectedPosts
      const created = yield* svc.create(Posts, { title: "X", authorId: "user2" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc
        .update(ProtectedPosts, id, { title: "Y" }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
        if (result.left._tag === "ForbiddenError") {
          expect(result.left.action).toBe("update")
        }
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("no rules → ForbiddenError", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc
        .update(NoRulePosts, "anyid", { title: "X" }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("view collection → ReadOnlyError", () =>
    Effect.gen(function* () {
      yield* setupViewTables
      const svc = yield* CollectionService
      const result = yield* svc
        .update(ActivePosts, "anyid", { title: "X" }, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ReadOnlyError")
      }
    }).pipe(Effect.provide(testLayer)))
})

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("delete", () => {
  it.effect("deletes an existing row and returns void", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "Gone" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      yield* svc.delete(Posts, id, noCtx)
    }).pipe(Effect.provide(testLayer)))

  it.effect("row is gone after delete (confirmed via view)", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "Gone" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      yield* svc.delete(Posts, id, noCtx)
      const result = yield* svc.view(Posts, id, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotFoundError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("NotFoundError for unknown id", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.delete(Posts, "nosuchid1234567", noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("NotFoundError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("ForbiddenError when rule blocks delete", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Posts, { title: "X", authorId: "user2" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc
        .delete(ProtectedPosts, id, noCtx)
        .pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
        if (result.left._tag === "ForbiddenError") {
          expect(result.left.action).toBe("delete")
        }
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("no rules → ForbiddenError", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const result = yield* svc.delete(NoRulePosts, "anyid", noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ForbiddenError")
      }
    }).pipe(Effect.provide(testLayer)))

  it.effect("view collection → ReadOnlyError", () =>
    Effect.gen(function* () {
      yield* setupViewTables
      const svc = yield* CollectionService
      const result = yield* svc.delete(ActivePosts, "anyid", noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ReadOnlyError")
      }
    }).pipe(Effect.provide(testLayer)))
})

// ---------------------------------------------------------------------------
// error callback — integration tests
// ---------------------------------------------------------------------------

describe("error callback — integration", () => {
  it.effect("minLength message propagates from create", () =>
    Effect.gen(function* () {
      yield* setupScoredTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Scored, { name: "x", score: 50 }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result) && result.left._tag === "ValidationError") {
        expect(result.left.issues.some((i) => i.includes("Name too short"))).toBe(true)
      }
    }).pipe(Effect.provide(scoredTestLayer)))

  it.effect("minimum message propagates from create", () =>
    Effect.gen(function* () {
      yield* setupScoredTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Scored, { name: "ok", score: -1 }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result) && result.left._tag === "ValidationError") {
        expect(result.left.issues.some((i) => i.includes("Score below zero"))).toBe(true)
      }
    }).pipe(Effect.provide(scoredTestLayer)))

  it.effect("maximum message propagates from create", () =>
    Effect.gen(function* () {
      yield* setupScoredTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Scored, { name: "ok", score: 200 }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result) && result.left._tag === "ValidationError") {
        expect(result.left.issues.some((i) => i.includes("Score above 100"))).toBe(true)
      }
    }).pipe(Effect.provide(scoredTestLayer)))

  it.effect("required message propagates from create", () =>
    Effect.gen(function* () {
      yield* setupScoredTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Scored, { score: 50 }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result) && result.left._tag === "ValidationError") {
        expect(result.left.issues.some((i) => i.includes("Name is required"))).toBe(true)
      }
    }).pipe(Effect.provide(scoredTestLayer)))

  it.effect("Match.orElse fallback fires for type mismatch", () =>
    Effect.gen(function* () {
      yield* setupScoredTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Scored, { name: 999, score: 50 }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result) && result.left._tag === "ValidationError") {
        expect(result.left.issues.some((i) => i.includes("Invalid name"))).toBe(true)
      }
    }).pipe(Effect.provide(scoredTestLayer)))

  it.effect("update with too-short name produces default message (no custom error on update path)", () =>
    Effect.gen(function* () {
      yield* setupScoredTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Scored, { name: "ok", score: 50 }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc.update(Scored, id, { name: "x" }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
        if (result.left._tag === "ValidationError") {
          expect(result.left.issues.length).toBeGreaterThan(0)
        }
      }
    }).pipe(Effect.provide(scoredTestLayer)))

  it.effect("valid data succeeds", () =>
    Effect.gen(function* () {
      yield* setupScoredTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Scored, { name: "ok", score: 50 }, noCtx)
      expect(result["name"]).toBe("ok")
      expect(result["score"]).toBe(50)
    }).pipe(Effect.provide(scoredTestLayer)))
})

// ---------------------------------------------------------------------------
// literalText integration tests
// ---------------------------------------------------------------------------

const setupRolesTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "roles" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "role"    TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "roles"`)
})

describe("literalText integration", () => {
  it.effect("create with valid literal value succeeds", () =>
    Effect.gen(function* () {
      yield* setupRolesTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Roles, { role: "admin" }, noCtx)
      expect(result["role"]).toBe("admin")
    }).pipe(Effect.provide(rolesTestLayer)))

  it.effect("create with invalid literal value fails with ValidationError", () =>
    Effect.gen(function* () {
      yield* setupRolesTable
      const svc = yield* CollectionService
      const result = yield* svc.create(Roles, { role: "superadmin" }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(rolesTestLayer)))

  it.effect("update with invalid literal value fails with ValidationError", () =>
    Effect.gen(function* () {
      yield* setupRolesTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Roles, { role: "admin" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const result = yield* svc.update(Roles, id, { role: "superadmin" }, noCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(rolesTestLayer)))

  it.effect("update with valid literal value succeeds", () =>
    Effect.gen(function* () {
      yield* setupRolesTable
      const svc = yield* CollectionService
      const created = yield* svc.create(Roles, { role: "admin" }, noCtx)
      const id = created["id"]
      if (typeof id !== "string") throw new Error("expected string id")
      const updated = yield* svc.update(Roles, id, { role: "agent" }, noCtx)
      expect(updated["role"]).toBe("agent")
    }).pipe(Effect.provide(rolesTestLayer)))
})

// ---------------------------------------------------------------------------
// AuthCollection create — regression: email/password were blocked by x-system
// ---------------------------------------------------------------------------

const SuperAdmin = AuthCollection.define("_superadmin", {}).rules((R) => ({
  list: R.field("email").eq(R.literal("")),
  view: R.field("email").eq(R.literal("")),
  create: R.public(),
  update: R.field("email").eq(R.literal("")),
  delete: R.field("email").eq(R.literal(""))
}))

const setupSuperAdminTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "_superadmin" (
      "seqId"         INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"            TEXT NOT NULL UNIQUE,
      "email"         TEXT NOT NULL UNIQUE,
      "password"      TEXT NOT NULL,
      "emailVerified" INTEGER NOT NULL DEFAULT 0,
      "created"       TEXT NOT NULL,
      "updated"       TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "_superadmin"`)
})

const superAdminTestLayer = Layer.mergeAll(
  makeCollectionServiceLayer([SuperAdmin]).pipe(
    Layer.provide(RepositoryLive),
    Layer.provide(sqliteLayer),
    Layer.provide(FileStorageTest),
    Layer.provide(NodeCryptoLayer)
  ),
  sqliteLayer,
  FileStorageTest,
  NodeCryptoLayer
)

const adminCtx: RequestCtx = { headers: {}, query: {}, admin: true }

describe("AuthCollection create", () => {
  it.effect("succeeds with email and password (regression: was blocked by x-system check)", () =>
    Effect.gen(function* () {
      yield* setupSuperAdminTable
      const svc = yield* CollectionService
      const record = yield* svc.create(SuperAdmin, { email: "admin@example.com", password: "hashed-pw" }, adminCtx)
      expect(record["email"]).toBe("admin@example.com")
      expect(typeof record["id"]).toBe("string")
      expect(record["id"]).not.toBe("")
    }).pipe(Effect.provide(superAdminTestLayer)))

  it.effect("rejects attempt to set generated field id", () =>
    Effect.gen(function* () {
      yield* setupSuperAdminTable
      const svc = yield* CollectionService
      const result = yield* svc.create(SuperAdmin, { email: "a@b.com", password: "pw", id: "custom-id" }, adminCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(superAdminTestLayer)))

  it.effect("fails validation when email is missing", () =>
    Effect.gen(function* () {
      yield* setupSuperAdminTable
      const svc = yield* CollectionService
      const result = yield* svc.create(SuperAdmin, { password: "pw" }, adminCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(superAdminTestLayer)))

  it.effect("fails validation when email format is invalid", () =>
    Effect.gen(function* () {
      yield* setupSuperAdminTable
      const svc = yield* CollectionService
      const result = yield* svc.create(SuperAdmin, { email: "notanemail", password: "pw" }, adminCtx).pipe(Effect.either)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("ValidationError")
      }
    }).pipe(Effect.provide(superAdminTestLayer)))
})
