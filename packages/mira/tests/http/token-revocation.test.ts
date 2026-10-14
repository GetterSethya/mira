/**
 * Hardening tests for the durable `TokenStore` + `pwf` credential binding +
 * generation-based "log out everywhere".
 *
 * These build the router over a real in-memory SQLite client with an explicit
 * `TokenStoreLive` (as `MiraApp` wires it), so every assertion exercises the
 * SQL-backed store rather than the process-local default.
 */
import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { hashPassword, signJwt } from "@/http/auth.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { TokenStore, TokenStoreLive } from "@/http/token-store.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const usersDef = AuthCollection.define("users", {})
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId()),
}))

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
  content: Field.text({ required: false }),
})
const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const [Users, Posts] = applyRulesToCollections([usersDef, postsDef], [usersRules, postsRules])
const ALL_COLLECTIONS = [Users, Posts]

const JWT_SECRET = "token-revocation-test-secret"

const AppConfigTest = Layer.succeed(
  AppConfig,
  AppConfig.of({
    appName: "test",
    port: 8080,
    applicationUrl: "http://localhost:8080",
    jwtSecret: Redacted.make(JWT_SECRET),
    useS3: false,
    s3Config: Option.none(),
    logRetentionDays: 30,
  })
)

// ---------------------------------------------------------------------------
// Test layer (explicit SQL-backed TokenStore, as MiraApp wires it)
// ---------------------------------------------------------------------------

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

// Every sub-layer shares the one sqlite connection via the merge memo map, so
// the TokenStore, Repository and the test body all act on the same database.
const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))

const collectionServiceWithDeps = makeCollectionServiceLayer(ALL_COLLECTIONS).pipe(
  Layer.provide(repoWithSql),
  Layer.provide(FileStorageTest),
  Layer.provide(sqliteLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)

const tokenStoreLayer = TokenStoreLive.pipe(Layer.provide(sqliteLayer))

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
  tokenStoreLayer
)

// ---------------------------------------------------------------------------
// Setup + helpers
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
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL DEFAULT '',
      "content" TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("posts")}`
})

function seedUser(email: string, plain: string) {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const hash = yield* hashPassword(plain)
    const record = yield* repo.create("users", { email, password: hash }).pipe(Effect.orDie)
    const id: unknown = record["id"]
    if (typeof id !== "string") return yield* Effect.die("seedUser: expected string record id")
    return id
  })
}

const serve = () =>
  Effect.flatMap(
    HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))),
    HttpServer.serveEffect()
  )

const decodeToken = Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))

function login(email: string, password: string) {
  return Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
        HttpClientRequest.bodyJsonUnsafe({ email, password })
      )
    )
    const body = yield* res.json
    const { token } = yield* decodeToken(body).pipe(Effect.orDie)
    return token
  })
}

function get(path: string, token?: string) {
  const req = HttpClientRequest.get(path)
  return HttpClient.execute(
    token === undefined ? req : req.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  )
}

function postJson(path: string, body: unknown, token?: string) {
  const req = HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body))
  return HttpClient.execute(
    token === undefined ? req : req.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TokenStore durability", () => {
  it.effect("a revoked jti is persisted and visible to a freshly constructed TokenStoreLive", () =>
    Effect.gen(function* () {
      yield* setupTables
      const sql = yield* SqlClient.SqlClient

      // Two independently built SQL-backed stores over the same client. If the
      // state lived in a module-level Map these would be the same "memory".
      const buildFreshStore = Effect.gen(function* () {
        const ctx = yield* Effect.scoped(Layer.build(Layer.fresh(TokenStoreLive)))
        return Context.get(ctx, TokenStore)
      })
      const storeA = yield* buildFreshStore
      const storeB = yield* buildFreshStore

      const jti = "jti-durable-42"
      yield* storeA.revoke(jti, Date.now() + 60_000)

      // The row is in the table (durable), not just in process memory.
      const rows = yield* sql<{ jti: string }>`
        SELECT jti FROM ${sql("_revoked_tokens")} WHERE jti = ${jti}
      `
      assert.strictEqual(rows.length, 1)

      assert.strictEqual(yield* storeA.isRevoked(jti), true)
      assert.strictEqual(yield* storeB.isRevoked(jti), true)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("an expired jti is not reported as revoked", () =>
    Effect.gen(function* () {
      yield* setupTables
      const sql = yield* SqlClient.SqlClient
      const ctx = yield* Effect.scoped(Layer.build(Layer.fresh(TokenStoreLive)))
      const store = Context.get(ctx, TokenStore)

      yield* store.revoke("jti-expired", Date.now() - 1_000)
      assert.strictEqual(yield* store.isRevoked("jti-expired"), false)
    }).pipe(Effect.provide(testLayer))
  )
})

describe("session revocation via HTTP", () => {
  it.effect("POST /api/auth/logout revokes the presented token (401 on /api/auth/me)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("logout@example.com", "pw123")
      yield* serve()

      const token = yield* login("logout@example.com", "pw123")
      assert.strictEqual((yield* get("/api/auth/me", token)).status, 200)

      const logout = yield* postJson("/api/auth/logout", {}, token)
      assert.strictEqual(logout.status, 204)

      assert.strictEqual((yield* get("/api/auth/me", token)).status, 401)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("a password change invalidates tokens minted before it (pwf mismatch)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const userId = yield* seedUser("pwchange@example.com", "oldpass")
      yield* serve()

      const token = yield* login("pwchange@example.com", "oldpass")
      assert.strictEqual((yield* get("/api/auth/me", token)).status, 200)

      // A direct Repository write models any other password writer (dashboard
      // admin path, raw SQL, a migration) — it bypasses the router entirely.
      const repo = yield* Repository
      const newHash = yield* hashPassword("newpass")
      yield* repo.update("users", userId, { password: newHash }).pipe(Effect.orDie)

      assert.strictEqual((yield* get("/api/auth/me", token)).status, 401)

      // A fresh login with the new password mints a valid token again.
      const fresh = yield* login("pwchange@example.com", "newpass")
      assert.strictEqual((yield* get("/api/auth/me", fresh)).status, 200)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST /api/auth/logout-all invalidates every existing token for the user", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("logoutall@example.com", "pw123")
      yield* serve()

      const token1 = yield* login("logoutall@example.com", "pw123")
      const token2 = yield* login("logoutall@example.com", "pw123")
      assert.strictEqual((yield* get("/api/auth/me", token1)).status, 200)
      assert.strictEqual((yield* get("/api/auth/me", token2)).status, 200)

      const res = yield* postJson("/api/auth/logout-all", {}, token1)
      assert.strictEqual(res.status, 204)

      assert.strictEqual((yield* get("/api/auth/me", token1)).status, 401)
      assert.strictEqual((yield* get("/api/auth/me", token2)).status, 401)

      // A subsequent login is on the new generation and still works.
      const token3 = yield* login("logoutall@example.com", "pw123")
      assert.strictEqual((yield* get("/api/auth/me", token3)).status, 200)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST /api/auth/logout-all without a token is 401", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve()
      const res = yield* postJson("/api/auth/logout-all", {})
      assert.strictEqual(res.status, 401)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("a session token signed without pwf is rejected", () =>
    Effect.gen(function* () {
      yield* setupTables
      const userId = yield* seedUser("nopwf@example.com", "pw123")
      yield* serve()

      const token = yield* signJwt({ sub: userId, col: "users" }, JWT_SECRET).pipe(Effect.orDie)
      assert.strictEqual((yield* get("/api/auth/me", token)).status, 401)
    }).pipe(Effect.provide(testLayer))
  )
})
