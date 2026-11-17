import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { MAX_BULK_RECORDS, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"
import { rateLimitTestLayer } from "@tests/_rate-limit.js"

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
  content: Field.text({ required: false })
})
const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

// Create rule reads the submitted payload: "blocked" is rejected per record.
const moderatedDef = BaseCollection.define("moderated", {
  title: Field.text()
})
const moderatedRules = defineRule(moderatedDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.field("title").neq(R.literal("blocked")),
  update: R.public(),
  delete: R.public()
}))

// Update rule reads the submitted patch: an update whose body title is
// "blocked" is denied, which lets a batch prove per-record rule enforcement.
const guardedDef = BaseCollection.define("guarded", {
  title: Field.text()
})
const guardedRules = defineRule(guardedDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.request("body", "title").neq(R.literal("blocked")),
  delete: R.public()
}))

// No delete rule at all → every delete is denied.
const lockedDef = BaseCollection.define("locked", {
  title: Field.text()
})
const lockedRules = defineRule(lockedDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public()
}))

const usersDef = AuthCollection.define("users", {})
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const [Posts, Moderated, Guarded, Locked, Users] = applyRulesToCollections(
  [postsDef, moderatedDef, guardedDef, lockedDef, usersDef],
  [postsRules, moderatedRules, guardedRules, lockedRules, usersRules]
)

const ALL_COLLECTIONS = [Posts, Moderated, Guarded, Locked, Users]

const AppConfigTest = Layer.succeed(
  AppConfig,
  AppConfig.of({
    appName: "test",
    port: 8080,
    applicationUrl: "http://localhost:8080",
    jwtSecret: Redacted.make("test-jwt-secret"),
    useS3: false,
    s3Config: Option.none(),
    logRetentionDays: 30
  })
)

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
const repoWithSql = RepositoryLive.pipe(Layer.provide(Layer.mergeAll(sqliteLayer, NodeCryptoLayer, Layer.succeed(Dialect, sqliteDialect))))

const collectionServiceWithDeps = makeCollectionServiceLayer(ALL_COLLECTIONS).pipe(
  Layer.provide(repoWithSql),
  Layer.provide(FileStorageTest),
  Layer.provide(sqliteLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)

const testLayer = Layer.mergeAll(
  collectionServiceWithDeps,
  repoWithSql,
  FileStorageTest,
  sqliteLayer,
  ThumbnailServiceNoopLive,
  NodeHttpServer.layerTest,
  AppConfigTest,
  NodeCryptoLayer,
  NodeAuthServiceLayer,
  DialectTest,
  rateLimitTestLayer
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "content" TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("posts")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "moderated" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("moderated")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "guarded" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("guarded")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "locked" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("locked")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "users" (
      "seqId"         INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"            TEXT NOT NULL UNIQUE,
      "email"         TEXT NOT NULL UNIQUE,
      "password"      TEXT NOT NULL,
      "emailVerified" INTEGER NOT NULL DEFAULT 0,
      "created"       TEXT NOT NULL,
      "updated"       TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("users")}`
})

const serve = Effect.flatMap(
  HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))),
  HttpServer.serveEffect()
)

function bulkRequest(name: string, body: unknown) {
  return HttpClient.execute(
    HttpClientRequest.post(`/api/collections/${name}/bulk`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body)
    )
  )
}

function bulkUpdateRequest(name: string, body: unknown) {
  return HttpClient.execute(
    HttpClientRequest.patch(`/api/collections/${name}/bulk`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body)
    )
  )
}

function bulkDeleteRequest(name: string, body: unknown) {
  return HttpClient.execute(
    HttpClientRequest.delete(`/api/collections/${name}/bulk`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body)
    )
  )
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function recordsOf(body: unknown): ReadonlyArray<JsonObject> {
  if (!isJsonObject(body)) return []
  const records: unknown = body["records"]
  if (!Array.isArray(records)) return []
  return records.filter(isJsonObject)
}

function countRows(table: "posts" | "moderated" | "guarded" | "locked" | "users") {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`
    return rows[0]?.["count"] ?? 0
  })
}

function titleById(table: "posts" | "moderated" | "guarded" | "locked", id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ title: string }>`SELECT title FROM ${sql(table)} WHERE id = ${id}`
    return rows[0]?.["title"]
  })
}

/** Seed rows through the bulk-create endpoint and return their ids in order. */
function seedPosts(name: string, titles: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const res = yield* bulkRequest(name, { records: titles.map((title) => ({ title })) })
    assert.strictEqual(res.status, 201)
    return recordsOf(yield* res.json).map((record) => {
      const id = record["id"]
      if (typeof id !== "string") return ""
      return id
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/collections/:name/bulk", () => {
  it.effect("inserts every record and returns them in order", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const res = yield* bulkRequest("posts", {
        records: [
          { title: "one", content: "a" },
          { title: "two", content: "b" },
          { title: "three" }
        ]
      })
      assert.strictEqual(res.status, 201)
      const records = recordsOf(yield* res.json)
      assert.strictEqual(records.length, 3)
      assert.deepStrictEqual(
        records.map((r) => r["title"]),
        ["one", "two", "three"]
      )
      assert.ok(records.every((r) => typeof r["id"] === "string"))
      assert.strictEqual(yield* countRows("posts"), 3)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rolls back the whole batch when one record fails validation", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const res = yield* bulkRequest("posts", {
        records: [{ title: "valid" }, { title: 42 }, { title: "also valid" }]
      })
      assert.strictEqual(res.status, 422)
      assert.strictEqual(yield* countRows("posts"), 0)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("enforces the create rule per record and rolls back", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const res = yield* bulkRequest("moderated", {
        records: [{ title: "fine" }, { title: "blocked" }]
      })
      assert.strictEqual(res.status, 403)
      assert.strictEqual(yield* countRows("moderated"), 0)

      const ok = yield* bulkRequest("moderated", { records: [{ title: "fine" }, { title: "also fine" }] })
      assert.strictEqual(ok.status, 201)
      assert.strictEqual(yield* countRows("moderated"), 2)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("hashes passwords, enforces credential checks and strips hidden fields", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const ok = yield* bulkRequest("users", {
        records: [
          { email: "a@example.com", password: "secret-a", passwordConfirm: "secret-a" },
          { email: "b@example.com", password: "secret-b", passwordConfirm: "secret-b" }
        ]
      })
      assert.strictEqual(ok.status, 201)
      const records = recordsOf(yield* ok.json)
      assert.strictEqual(records.length, 2)
      assert.ok(records.every((r) => !("password" in r)))

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ email: string; password: string }>`SELECT email, password FROM ${sql("users")}`
      assert.strictEqual(rows.length, 2)
      assert.ok(rows.every((r) => r.password !== "secret-a" && r.password !== "secret-b"))
      assert.ok(rows.every((r) => r.password.startsWith("scrypt$")))

      // A mismatched confirmation anywhere in the batch fails the whole batch.
      const bad = yield* bulkRequest("users", {
        records: [
          { email: "c@example.com", password: "secret-c", passwordConfirm: "secret-c" },
          { email: "d@example.com", password: "secret-d", passwordConfirm: "different" }
        ]
      })
      assert.strictEqual(bad.status, 422)
      assert.strictEqual(yield* countRows("users"), 2)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects an empty records array", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const res = yield* bulkRequest("posts", { records: [] })
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects a missing or non-array records field", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const missing = yield* bulkRequest("posts", {})
      assert.strictEqual(missing.status, 422)
      const wrongType = yield* bulkRequest("posts", { records: "nope" })
      assert.strictEqual(wrongType.status, 422)
      const notObject = yield* bulkRequest("posts", [{ title: "x" }])
      assert.strictEqual(notObject.status, 422)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects a batch larger than the limit", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const tooMany = Array.from({ length: MAX_BULK_RECORDS + 1 }, (_, i) => ({ title: `p${i}` }))
      const res = yield* bulkRequest("posts", { records: tooMany })
      assert.strictEqual(res.status, 422)
      assert.strictEqual(yield* countRows("posts"), 0)

      // Exactly at the limit is accepted.
      const atLimit = Array.from({ length: MAX_BULK_RECORDS }, (_, i) => ({ title: `p${i}` }))
      const ok = yield* bulkRequest("posts", { records: atLimit })
      assert.strictEqual(ok.status, 201)
      assert.strictEqual(yield* countRows("posts"), MAX_BULK_RECORDS)
    }).pipe(Effect.provide(testLayer))
  )
})

describe("PATCH /api/collections/:name/bulk", () => {
  it.effect("updates every record and returns them in input order", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second, third] = yield* seedPosts("posts", ["one", "two", "three"])

      const res = yield* bulkUpdateRequest("posts", {
        records: [
          { id: second, data: { title: "two-updated" } },
          { id: first, data: { title: "one-updated", content: "body" } }
        ]
      })
      assert.strictEqual(res.status, 200)
      const records = recordsOf(yield* res.json)
      assert.deepStrictEqual(
        records.map((r) => r["title"]),
        ["two-updated", "one-updated"]
      )
      assert.deepStrictEqual(
        records.map((r) => r["id"]),
        [second, first]
      )
      assert.strictEqual(yield* titleById("posts", second), "two-updated")
      assert.strictEqual(yield* titleById("posts", first), "one-updated")
      assert.strictEqual(yield* titleById("posts", third), "three")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rolls back every update when an id is missing", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second] = yield* seedPosts("posts", ["one", "two"])

      const res = yield* bulkUpdateRequest("posts", {
        records: [
          { id: first, data: { title: "changed" } },
          { id: "does-not-exist", data: { title: "nope" } }
        ]
      })
      assert.strictEqual(res.status, 404)
      assert.strictEqual(yield* titleById("posts", first), "one")
      assert.strictEqual(yield* titleById("posts", second), "two")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rolls back every update when one payload fails validation", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second] = yield* seedPosts("posts", ["one", "two"])

      const res = yield* bulkUpdateRequest("posts", {
        records: [
          { id: first, data: { title: "changed" } },
          { id: second, data: { title: 42 } }
        ]
      })
      assert.strictEqual(res.status, 422)
      assert.strictEqual(yield* titleById("posts", first), "one")
      assert.strictEqual(yield* titleById("posts", second), "two")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("enforces the update rule per record and rolls back", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second] = yield* seedPosts("guarded", ["fine-one", "fine-two"])

      const res = yield* bulkUpdateRequest("guarded", {
        records: [
          { id: first, data: { title: "fine-one-updated" } },
          { id: second, data: { title: "blocked" } }
        ]
      })
      assert.strictEqual(res.status, 403)
      assert.strictEqual(yield* titleById("guarded", first), "fine-one")
      assert.strictEqual(yield* titleById("guarded", second), "fine-two")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects duplicate ids without applying either update", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first] = yield* seedPosts("posts", ["one"])

      const res = yield* bulkUpdateRequest("posts", {
        records: [
          { id: first, data: { title: "first" } },
          { id: first, data: { title: "second" } }
        ]
      })
      assert.strictEqual(res.status, 422)
      assert.strictEqual(yield* titleById("posts", first), "one")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects empty and malformed bodies", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first] = yield* seedPosts("posts", ["one"])

      const empty = yield* bulkUpdateRequest("posts", { records: [] })
      assert.strictEqual(empty.status, 422)
      const missing = yield* bulkUpdateRequest("posts", {})
      assert.strictEqual(missing.status, 422)
      const badShape = yield* bulkUpdateRequest("posts", { records: [{ id: first }] })
      assert.strictEqual(badShape.status, 422)
      const noId = yield* bulkUpdateRequest("posts", { records: [{ data: { title: "x" } }] })
      assert.strictEqual(noId.status, 422)
      const emptyId = yield* bulkUpdateRequest("posts", { records: [{ id: "", data: { title: "x" } }] })
      assert.strictEqual(emptyId.status, 422)
      // Nothing above touched the row.
      assert.strictEqual(yield* titleById("posts", first), "one")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects a batch larger than the limit", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const tooMany = Array.from({ length: MAX_BULK_RECORDS + 1 }, (_, i) => ({
        id: `id-${i}`,
        data: { title: `p${i}` }
      }))
      const res = yield* bulkUpdateRequest("posts", { records: tooMany })
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(testLayer))
  )
})

describe("DELETE /api/collections/:name/bulk", () => {
  it.effect("deletes every id and returns the deleted ids in input order", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second, third] = yield* seedPosts("posts", ["one", "two", "three"])

      const res = yield* bulkDeleteRequest("posts", { ids: [third, first] })
      assert.strictEqual(res.status, 200)
      const body: unknown = yield* res.json
      if (!isJsonObject(body)) return yield* Effect.die("expected JSON object response")
      const ids: unknown = body["ids"]
      if (!isStringArray(ids)) return yield* Effect.die("expected ids string array")
      assert.deepStrictEqual(ids, [third, first])
      assert.strictEqual(yield* countRows("posts"), 1)
      assert.strictEqual(yield* titleById("posts", second), "two")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rolls back every delete when an id is missing", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second] = yield* seedPosts("posts", ["one", "two"])

      const res = yield* bulkDeleteRequest("posts", { ids: [first, "does-not-exist"] })
      assert.strictEqual(res.status, 404)
      assert.strictEqual(yield* countRows("posts"), 2)
      assert.strictEqual(yield* titleById("posts", first), "one")
      assert.strictEqual(yield* titleById("posts", second), "two")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rolls back every delete when the delete rule denies one id", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second] = yield* seedPosts("locked", ["one", "two"])

      const res = yield* bulkDeleteRequest("locked", { ids: [first, second] })
      assert.strictEqual(res.status, 403)
      assert.strictEqual(yield* countRows("locked"), 2)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects duplicate ids without deleting anything", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const [first, second] = yield* seedPosts("posts", ["one", "two"])

      const res = yield* bulkDeleteRequest("posts", { ids: [first, first] })
      assert.strictEqual(res.status, 422)
      assert.strictEqual(yield* countRows("posts"), 2)
      assert.strictEqual(yield* titleById("posts", second), "two")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects empty and malformed bodies", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      yield* seedPosts("posts", ["one"])

      const empty = yield* bulkDeleteRequest("posts", { ids: [] })
      assert.strictEqual(empty.status, 422)
      const missing = yield* bulkDeleteRequest("posts", {})
      assert.strictEqual(missing.status, 422)
      const wrongType = yield* bulkDeleteRequest("posts", { ids: "nope" })
      assert.strictEqual(wrongType.status, 422)
      const emptyId = yield* bulkDeleteRequest("posts", { ids: [""] })
      assert.strictEqual(emptyId.status, 422)
      assert.strictEqual(yield* countRows("posts"), 1)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects a batch larger than the limit", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      const tooMany = Array.from({ length: MAX_BULK_RECORDS + 1 }, (_, i) => `id-${i}`)
      const res = yield* bulkDeleteRequest("posts", { ids: tooMany })
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(testLayer))
  )
})
