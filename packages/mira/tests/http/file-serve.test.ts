import { HttpClient, HttpServer } from "@effect/platform"
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
import { hashPassword, signFileToken, AuthService } from "@/http/auth.js"
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

const PublicDocs = BaseCollection.define("public_docs", {
  title: Field.text(),
  attachment: Field.file({ required: false }),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

// Protected file — view rule is public so any authenticated token holder may access
const ProtectedDocs = BaseCollection.define("protected_docs", {
  title: Field.text(),
  attachment: Field.file({ protected: true, required: false }),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

// Protected file — no rules at all (default deny)
const SecretDocs = BaseCollection.define("secret_docs", {
  title: Field.text(),
  attachment: Field.file({ protected: true, required: false }),
})

const JWT_SECRET = "test-file-serve-secret"
const ALL_COLLECTIONS = [Users, PublicDocs, ProtectedDocs, SecretDocs]

const AppConfigTest = Layer.succeed(AppConfig, AppConfig.of({
  appName: "test",
  port: 8080,
  applicationUrl: "http://localhost:8080",
  jwtSecret: Redacted.make(JWT_SECRET),
  useS3: false,
  s3Config: Option.none(),
}))

// ---------------------------------------------------------------------------
// Static file fixture
// ---------------------------------------------------------------------------

const TEST_FILE_KEY = "test-abc123.jpg"
const TEST_FILE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) // fake JPEG header

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const FileStorageTest = Layer.succeed(FileStorage, FileStorage.of({
  upload: (key) => Effect.succeed(key),
  delete: () => Effect.void,
  url: (key) => `/files/${key}`,
  read: (key) =>
    key === TEST_FILE_KEY
      ? Effect.succeed(TEST_FILE_BYTES)
      : Effect.fail(new FileStorageNotFound({ key })),
  exists: (key) => Effect.succeed(key === TEST_FILE_KEY),
  list: (_prefix) => Effect.succeed([])
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
  for (const tbl of ["public_docs", "protected_docs", "secret_docs"]) {
    yield* sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "${tbl}" (
        "seqId"      INTEGER PRIMARY KEY AUTOINCREMENT,
        "id"         TEXT NOT NULL UNIQUE,
        "title"      TEXT NOT NULL DEFAULT '',
        "attachment" TEXT,
        "created"    TEXT NOT NULL,
        "updated"    TEXT NOT NULL
      )
    `)
    yield* sql`DELETE FROM ${sql(tbl)}`
  }
})

const IdSchema = Schema.Struct({ id: Schema.String })

function seedUser(email: string, plain: string): Effect.Effect<string, never, Repository | AuthService> {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const hash = yield* hashPassword(plain)
    const raw = yield* repo.create("users", { email, password: hash }).pipe(Effect.orDie)
    const { id } = yield* Schema.decodeUnknown(IdSchema)(raw).pipe(Effect.orDie)
    return id
  })
}

function seedRecord(
  collection: string,
  title: string,
  fileKey: string
): Effect.Effect<string, never, Repository> {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const raw = yield* repo.create(collection, { title, attachment: fileKey }).pipe(Effect.orDie)
    const { id } = yield* Schema.decodeUnknown(IdSchema)(raw).pipe(Effect.orDie)
    return id
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/files/:collection/:id/:filename", () => {
  it.scoped("returns 404 for unknown collection", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/files/no_such_collection/some-id/file.jpg")
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 404 when record does not exist", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/files/public_docs/nonexistent-id/file.jpg")
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 404 when filename does not match the stored key", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedRecord("public_docs", "Doc", TEST_FILE_KEY)
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get(`/api/files/public_docs/${id}/wrong-file.jpg`)
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("serves an unprotected file with the correct content-type", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedRecord("public_docs", "Doc", TEST_FILE_KEY)
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get(`/api/files/public_docs/${id}/${TEST_FILE_KEY}`)
      assert.strictEqual(res.status, 200)
      assert.ok(res.headers["content-type"]?.includes("image/jpeg"))
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 403 for a protected file with no token", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedRecord("protected_docs", "Protected Doc", TEST_FILE_KEY)
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get(`/api/files/protected_docs/${id}/${TEST_FILE_KEY}`)
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 403 for a protected file with an invalid token", () =>
    Effect.gen(function* () {
      yield* setupTables
      const id = yield* seedRecord("protected_docs", "Protected Doc", TEST_FILE_KEY)
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const res = yield* HttpClient.get(
        `/api/files/protected_docs/${id}/${TEST_FILE_KEY}?token=not-a-jwt`
      )
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 403 when file token targets a different collection", () =>
    Effect.gen(function* () {
      yield* setupTables
      const userId = yield* seedUser("dave@example.com", "pass")
      const id = yield* seedRecord("protected_docs", "Protected Doc", TEST_FILE_KEY)
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const wrongToken = yield* signFileToken(
        { sub: userId, col: "users", filecol: "public_docs" },
        JWT_SECRET
      ).pipe(Effect.orDie)
      const res = yield* HttpClient.get(
        `/api/files/protected_docs/${id}/${TEST_FILE_KEY}?token=${wrongToken}`
      )
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("serves a protected file when token is valid and view rule allows access", () =>
    Effect.gen(function* () {
      yield* setupTables
      const userId = yield* seedUser("eve@example.com", "pass")
      const id = yield* seedRecord("protected_docs", "Protected Doc", TEST_FILE_KEY)
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const fileToken = yield* signFileToken(
        { sub: userId, col: "users", filecol: "protected_docs" },
        JWT_SECRET
      ).pipe(Effect.orDie)
      const res = yield* HttpClient.get(
        `/api/files/protected_docs/${id}/${TEST_FILE_KEY}?token=${fileToken}`
      )
      assert.strictEqual(res.status, 200)
      assert.ok(res.headers["content-type"]?.includes("image/jpeg"))
    }).pipe(Effect.provide(testLayer))
  )

  it.scoped("returns 403 when collection has no view rule (default deny)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const userId = yield* seedUser("frank@example.com", "pass")
      const id = yield* seedRecord("secret_docs", "Top Secret", TEST_FILE_KEY)
      yield* makeCollectionRouter(ALL_COLLECTIONS).pipe(HttpServer.serveEffect())
      const fileToken = yield* signFileToken(
        { sub: userId, col: "users", filecol: "secret_docs" },
        JWT_SECRET
      ).pipe(Effect.orDie)
      const res = yield* HttpClient.get(
        `/api/files/secret_docs/${id}/${TEST_FILE_KEY}?token=${fileToken}`
      )
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(testLayer))
  )
})
