import { Cookies, HttpClient, HttpClientError, HttpClientRequest, HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { AuthCollection } from "@gettersethya/mira-client"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"
import { hashPassword, AuthService } from "@/http/auth.js"
import { makeCollectionRouter } from "@/http/router.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const Users = AuthCollection.define("users", {}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const Docs = BaseCollection.define("docs", {
  title: Field.text(),
  attachment: Field.file({ required: false }),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const JWT_SECRET = "test-file-token-secret"
const ALL_COLLECTIONS = [Users, Docs]

const AppConfigTest = Layer.succeed(AppConfig, AppConfig.of({
  appName: "test",
  port: 8080,
  applicationUrl: "http://localhost:8080",
  jwtSecret: Redacted.make(JWT_SECRET),
  useS3: false,
  s3Config: Option.none(),
}))

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
const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))

const collectionServiceWithDeps = makeCollectionServiceLayer(ALL_COLLECTIONS).pipe(
  Layer.provide(repoWithSql),
  Layer.provide(FileStorageTest),
  Layer.provide(sqliteLayer)
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

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "users" (
      "seqId"          INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"             TEXT NOT NULL UNIQUE,
      "email"          TEXT NOT NULL UNIQUE,
      "password"       TEXT NOT NULL,
      "emailVerified"  INTEGER NOT NULL DEFAULT 0,
      "created"        TEXT NOT NULL,
      "updated"        TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("users")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "docs" (
      "seqId"       INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"          TEXT NOT NULL UNIQUE,
      "title"       TEXT NOT NULL DEFAULT '',
      "attachment"  TEXT,
      "created"     TEXT NOT NULL,
      "updated"     TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("docs")}`
})

function seedUser(email: string, plain: string): Effect.Effect<string, never, Repository | AuthService> {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const hash = yield* hashPassword(plain)
    const raw = yield* repo.create("users", { email, password: hash }).pipe(Effect.orDie)
    const { id } = yield* Schema.decodeUnknown(Schema.Struct({ id: Schema.String }))(raw).pipe(Effect.orDie)
    return id
  })
}

function login(email: string, password: string): Effect.Effect<string, HttpClientError.HttpClientError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
        HttpClientRequest.bodyUnsafeJson({ email, password })
      )
    )
    const body = yield* res.json
    const { token } = yield* Schema.decodeUnknown(Schema.Struct({ token: Schema.String }))(body).pipe(Effect.orDie)
    return token
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/files/token", () => {
  it.scoped("returns 401 when no auth token is provided", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/files/token").pipe(
          HttpClientRequest.bodyUnsafeJson({ collection: "docs" })
        )
      )
      assert.strictEqual(res.status, 401)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 401 when Bearer token is invalid", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/files/token").pipe(
          HttpClientRequest.setHeader("Authorization", "Bearer not-a-valid-jwt"),
          HttpClientRequest.bodyUnsafeJson({ collection: "docs" })
        )
      )
      assert.strictEqual(res.status, 401)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 422 when body is missing collection field", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("alice@example.com", "pass123")
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const token = yield* login("alice@example.com", "pass123")
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/files/token").pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.bodyUnsafeJson({})
        )
      )
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 404 for an unknown collection", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("bob@example.com", "pass456")
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const token = yield* login("bob@example.com", "pass456")
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/files/token").pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.bodyUnsafeJson({ collection: "nonexistent" })
        )
      )
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 200 with token and expiresAt for valid request", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("carol@example.com", "pass789")
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const token = yield* login("carol@example.com", "pass789")
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/files/token").pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
          HttpClientRequest.bodyUnsafeJson({ collection: "docs" })
        )
      )
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      const parsed = yield* Schema.decodeUnknown(
        Schema.Struct({ token: Schema.String, expiresAt: Schema.Number })
      )(body).pipe(Effect.orDie)
      assert.ok(parsed.token.length > 0)
      assert.ok(parsed.expiresAt > Date.now())
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 200 with valid mira_token cookie and no Bearer header", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("cookiefile@example.com", "pass101")
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const loginRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyUnsafeJson({ email: "cookiefile@example.com", password: "pass101" })
        )
      )
      assert.strictEqual(loginRes.status, 200)
      const cookieToken = Option.getOrThrow(Cookies.getValue(loginRes.cookies, "mira_token"))
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/files/token").pipe(
          HttpClientRequest.setHeader("Cookie", `mira_token=${cookieToken}`),
          HttpClientRequest.bodyUnsafeJson({ collection: "docs" })
        )
      )
      assert.strictEqual(res.status, 200)
    }).pipe(Effect.provide(testLayer))
  )
})
