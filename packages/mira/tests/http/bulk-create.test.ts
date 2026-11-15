import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { MAX_BULK_CREATE_RECORDS, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"
import { rateLimitTestLayer } from "../_rate-limit.js"

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

const usersDef = AuthCollection.define("users", {})
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const [Posts, Moderated, Users] = applyRulesToCollections(
  [postsDef, moderatedDef, usersDef],
  [postsRules, moderatedRules, usersRules]
)

const ALL_COLLECTIONS = [Posts, Moderated, Users]

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
const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))

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

type JsonObject = Record<string, unknown>

function recordsOf(body: unknown): ReadonlyArray<JsonObject> {
  if (typeof body !== "object" || body === null) return []
  const records: unknown = (body as JsonObject)["records"]
  if (!Array.isArray(records)) return []
  return records.filter((r): r is JsonObject => typeof r === "object" && r !== null)
}

function countRows(table: "posts" | "moderated" | "users") {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`
    return rows[0]?.["count"] ?? 0
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
      const tooMany = Array.from({ length: MAX_BULK_CREATE_RECORDS + 1 }, (_, i) => ({ title: `p${i}` }))
      const res = yield* bulkRequest("posts", { records: tooMany })
      assert.strictEqual(res.status, 422)
      assert.strictEqual(yield* countRows("posts"), 0)

      // Exactly at the limit is accepted.
      const atLimit = Array.from({ length: MAX_BULK_CREATE_RECORDS }, (_, i) => ({ title: `p${i}` }))
      const ok = yield* bulkRequest("posts", { records: atLimit })
      assert.strictEqual(ok.status, 201)
      assert.strictEqual(yield* countRows("posts"), MAX_BULK_CREATE_RECORDS)
    }).pipe(Effect.provide(testLayer))
  )
})
