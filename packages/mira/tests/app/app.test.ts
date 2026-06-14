import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Redacted } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"
import { makeCollectionRouter } from "@/http/router.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { Mira } from "@/app/index.js"
import { NodePlatform } from "@/platforms/node.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { LocalFileStorage } from "@/storage/index.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const ALL_COLLECTIONS = [Posts]

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: ":memory:" }))
  .storage(LocalFileStorage({ directory: "./tmp/test-app" }))
  .collections(ALL_COLLECTIONS)
  .build()

const AppConfigTest = Layer.succeed(AppConfig, AppConfig.of({
  appName: "test",
  port: 8080,
  applicationUrl: "http://localhost:8080",
  jwtSecret: Redacted.make("test-secret"),
  useS3: false,
  s3Config: Option.none(),
  logRetentionDays: 30,
}))

const FileStorageTest = Layer.succeed(FileStorage, FileStorage.of({
  upload: (key) => Effect.succeed(key),
  delete: () => Effect.void,
  url: (key) => `/files/${key}`,
  read: (key) => Effect.fail(new FileStorageNotFound({ key })),
  exists: () => Effect.succeed(false),
  list: () => Effect.succeed([])
}))

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))
const collectionServiceWithDeps = makeCollectionServiceLayer(ALL_COLLECTIONS).pipe(
  Layer.provide(repoWithSql),
  Layer.provide(FileStorageTest),
  Layer.provide(sqliteLayer),
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
)

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL DEFAULT '',
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "posts"`)
})

describe("MiraApp integration", () => {
  it.scoped("GET /api/collections/posts returns empty list after migration", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/posts")
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "items" in body)
      const items = (body as { items: unknown[] }).items
      assert.ok(Array.isArray(items))
      assert.strictEqual(items.length, 0)
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("POST /api/collections/posts creates a record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyUnsafeJson({ title: "hello" }),
        ),
      )
      assert.strictEqual(res.status, 201)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "title" in body)
      assert.strictEqual((body as { title: string }).title, "hello")
      assert.ok("id" in body && typeof (body as { id: string }).id === "string")
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("POST then GET list returns the created record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyUnsafeJson({ title: "my post" }),
        ),
      )
      const res = yield* HttpClient.get("/api/collections/posts")
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "items" in body)
      const items = (body as { items: unknown[] }).items
      assert.strictEqual(items.length, 1)
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("POST then GET by id returns the record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const createRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyUnsafeJson({ title: "find me" }),
        ),
      )
      const created = yield* createRes.json
      assert.ok(typeof created === "object" && created !== null && "id" in created)
      const id = (created as { id: string }).id
      const res = yield* HttpClient.get(`/api/collections/posts/${id}`)
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null && "title" in body)
      assert.strictEqual((body as { title: string }).title, "find me")
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("GET /api/collections/unknown returns 404", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/unknown")
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer)),
  )

  it.scoped("MiraApp builder can be constructed", () =>
    Effect.gen(function* () {
      assert.ok(app)
    }).pipe(Effect.provide(testLayer)),
  )
})
