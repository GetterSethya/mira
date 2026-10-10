import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { AuthCollection } from "@gettersethya/mira-client"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { Effect, Layer, Option, Redacted } from "effect"
import { Cookies, HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections,defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import {hashPassword } from "@/http/auth.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

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

const Restricted = BaseCollection.define("restricted", {
  name: Field.text(),
})

const UserCollection = AuthCollection.define("users", {})
const userRules = defineRule(UserCollection, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId()),
}))

const SuperAdminCollection = AuthCollection.define("_superadmin", {})
const superAdminRules = defineRule(SuperAdminCollection, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const [Posts, Users, SuperAdmin] = applyRulesToCollections(
  [postsDef, UserCollection, SuperAdminCollection],
  [postsRules, userRules, superAdminRules]
)

const JWT_SECRET = "test-jwt-secret"
const ALL_COLLECTIONS = [Posts, Restricted, Users, SuperAdmin]
const ADMIN_COLLECTIONS = ["_superadmin"]

const AppConfigTest = Layer.succeed(AppConfig, AppConfig.of({
  appName: "test",
  port: 8080,
  applicationUrl: "http://localhost:8080",
  jwtSecret: Redacted.make(JWT_SECRET),
  useS3: false,
  s3Config: Option.none(),
  logRetentionDays: 30,
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
const DialectTest = Layer.succeed(Dialect, sqliteDialect)

// Repository wired to the shared sqlite connection
const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))

// CollectionService wired to all its dependencies
const collectionServiceWithDeps = makeCollectionServiceLayer(ALL_COLLECTIONS).pipe(
  Layer.provide(repoWithSql),
  Layer.provide(FileStorageTest),
  Layer.provide(sqliteLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)

// Merge everything needed by the router handlers + table setup into one test layer
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
)

// ---------------------------------------------------------------------------
// Table setup helper
// ---------------------------------------------------------------------------

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
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
  yield* sql.unsafe(`DELETE FROM "posts"`)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "restricted" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "name"    TEXT NOT NULL DEFAULT '',
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "restricted"`)
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
  yield* sql.unsafe(`DELETE FROM "users"`)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "_superadmin" (
      "seqId"          INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"             TEXT NOT NULL UNIQUE,
      "email"          TEXT NOT NULL UNIQUE,
      "password"       TEXT NOT NULL,
      "emailVerified"  INTEGER NOT NULL DEFAULT 0,
      "created"        TEXT NOT NULL,
      "updated"        TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("_superadmin")}`
})

// ---------------------------------------------------------------------------
// Helper: seed a user with hashed password, bypassing system-field validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function tokenFromLogin(body: unknown) {
  if (!isRecord(body)) return Effect.die("expected JSON object login response")
  const token: unknown = body["token"]
  if (typeof token !== "string") return Effect.die("expected string token in login response")
  return Effect.succeed(token)
}

function seedUser(
  email: string,
  plainPassword: string,
  table = "users"
) {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const hash = yield* hashPassword(plainPassword)
    const record = yield* repo.create(table, { email, password: hash }).pipe(Effect.orDie)
    const id: unknown = record["id"]
    if (typeof id !== "string") return yield* Effect.die("seedUser: expected string record id")
    return id
  })
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("makeCollectionRouter", () => {
  it.effect("GET /api/collections/:name — list returns empty result on empty table", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/posts")
      assert.strictEqual(res.status, 200)
      const body = yield* res.json
      assert.ok(typeof body === "object" && body !== null)
      const items = (body as { items: Array<unknown> }).items
      assert.ok(Array.isArray(items))
      assert.strictEqual(items.length, 0)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/collections/:name — list returns 404 for unknown collection", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/no_such_collection")
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST /api/collections/:name — create returns 201 with record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "Hello World", content: "body text" })
        )
      )
      assert.strictEqual(res.status, 201)
      const body = yield* res.json
      const record = body as Record<string, unknown>
      assert.strictEqual(record["title"], "Hello World")
      assert.strictEqual(record["content"], "body text")
      assert.ok(typeof record["id"] === "string")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST /api/collections/:name — create returns 403 when rules deny", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/restricted").pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: "secret" })
        )
      )
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/collections/:name/:id — view returns 200 with record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const createRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "Test Post" })
        )
      )
      assert.strictEqual(createRes.status, 201)
      const created = (yield* createRes.json) as Record<string, unknown>
      const id = created["id"] as string
      const res = yield* HttpClient.get(`/api/collections/posts/${id}`)
      assert.strictEqual(res.status, 200)
      const body = (yield* res.json) as Record<string, unknown>
      assert.strictEqual(body["id"], id)
      assert.strictEqual(body["title"], "Test Post")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/collections/:name/:id — view returns 404 for unknown id", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/posts/nonexistent-id")
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("PATCH /api/collections/:name/:id — update returns 200 with updated record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const createRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "Original" })
        )
      )
      const created = (yield* createRes.json) as Record<string, unknown>
      const id = created["id"] as string
      const res = yield* HttpClient.execute(
        HttpClientRequest.patch(`/api/collections/posts/${id}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "Updated" })
        )
      )
      assert.strictEqual(res.status, 200)
      const body = (yield* res.json) as Record<string, unknown>
      assert.strictEqual(body["title"], "Updated")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("DELETE /api/collections/:name/:id — delete returns 204 with empty body", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const createRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts").pipe(
          HttpClientRequest.bodyJsonUnsafe({ title: "To Delete" })
        )
      )
      const created = (yield* createRes.json) as Record<string, unknown>
      const id = created["id"] as string
      const res = yield* HttpClient.execute(HttpClientRequest.delete(`/api/collections/posts/${id}`))
      assert.strictEqual(res.status, 204)
      const text = yield* res.text
      assert.strictEqual(text, "")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("DELETE /api/collections/:name/:id — delete returns 404 for unknown id", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(HttpClientRequest.delete("/api/collections/posts/no-such-id"))
      assert.strictEqual(res.status, 404)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST auth-with-password — valid credentials return token and stripped record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("alice@example.com", "password123")
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "alice@example.com", password: "password123" })
        )
      )
      assert.strictEqual(res.status, 200)
      const body = (yield* res.json) as Record<string, unknown>
      assert.ok(typeof body["token"] === "string" && body["token"].length > 0)
      assert.ok(typeof body["record"] === "object" && body["record"] !== null)
      const user = body["record"] as Record<string, unknown>
      assert.strictEqual(user["email"], "alice@example.com")
      assert.ok(!("password" in user), "password must not appear in auth response")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST auth-with-password — wrong password returns 403", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("bob@example.com", "correctpass")
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "bob@example.com", password: "wrongpass" })
        )
      )
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST auth-with-password — non-auth collection returns 405", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/posts/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "x@x.com", password: "pass" })
        )
      )
      assert.strictEqual(res.status, 405)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST auth-with-password — missing fields returns 422", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "only@example.com" })
        )
      )
      assert.strictEqual(res.status, 422)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("JWT bearer token resolves auth context for subsequent requests", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("carol@example.com", "secret")
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const loginRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "carol@example.com", password: "secret" })
        )
      )
      assert.strictEqual(loginRes.status, 200)
      const loginBody = (yield* loginRes.json) as Record<string, unknown>
      const token = loginBody["token"] as string
      // Authenticated request — router resolves the auth context from the JWT
      const authedRes = yield* HttpClient.get("/api/collections/posts", {
        headers: { Authorization: `Bearer ${token}` }
      })
      assert.strictEqual(authedRes.status, 200)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST auth-with-password — response sets HttpOnly mira_token cookie", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("cookieuser@example.com", "secret")
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "cookieuser@example.com", password: "secret" })
        )
      )
      assert.strictEqual(res.status, 200)
      const cookieOpt = Cookies.get(res.cookies, "mira_token")
      assert.ok(Option.isSome(cookieOpt))
      assert.strictEqual(cookieOpt.value.options?.httpOnly, true)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/collections/:name — cookie auth returns 200 without Bearer header", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("cookieauth@example.com", "secret")
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const loginRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "cookieauth@example.com", password: "secret" })
        )
      )
      assert.strictEqual(loginRes.status, 200)
      const cookieToken = Option.getOrThrow(Cookies.getValue(loginRes.cookies, "mira_token"))
      const res = yield* HttpClient.get("/api/collections/posts", {
        headers: { Cookie: `mira_token=${cookieToken}` }
      })
      assert.strictEqual(res.status, 200)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/collections/:name — invalid cookie is treated as anonymous, returns 200 for public route", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/collections/posts", {
        headers: { Cookie: "mira_token=not-a-valid-jwt" }
      })
      assert.strictEqual(res.status, 200)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST /api/auth/logout — response clears mira_token cookie with Max-Age=0", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.execute(HttpClientRequest.post("/api/auth/logout"))
      assert.strictEqual(res.status, 204)
      const cookieOpt = Cookies.get(res.cookies, "mira_token")
      assert.ok(Option.isSome(cookieOpt))
      assert.ok(cookieOpt.value.options?.maxAge !== undefined)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/auth/me — valid cookie returns 200 with collection and record", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("meuser@example.com", "secret")
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const loginRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "meuser@example.com", password: "secret" })
        )
      )
      assert.strictEqual(loginRes.status, 200)
      const cookieToken = Option.getOrThrow(Cookies.getValue(loginRes.cookies, "mira_token"))
      const res = yield* HttpClient.get("/api/auth/me", {
        headers: { Cookie: `mira_token=${cookieToken}` }
      })
      assert.strictEqual(res.status, 200)
      const body = (yield* res.json) as Record<string, unknown>
      assert.strictEqual(body["collection"], "users")
      assert.ok(typeof body["record"] === "object" && body["record"] !== null)
      const record = body["record"] as Record<string, unknown>
      assert.strictEqual(record["email"], "meuser@example.com")
      assert.ok(!("password" in record), "password must not appear in /api/auth/me response")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/auth/me — no token returns 401", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const res = yield* HttpClient.get("/api/auth/me")
      assert.strictEqual(res.status, 401)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("POST /api/collections/users — password is hashed so auth-with-password succeeds", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const createRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "newuser@example.com", password: "plaintext-pw", passwordConfirm: "plaintext-pw" })
        )
      )
      assert.strictEqual(createRes.status, 201)
      const created = (yield* createRes.json) as Record<string, unknown>
      assert.ok(!("password" in created), "password must not be returned in create response")

      // If the password were stored verbatim, login would still succeed — so this
      // also asserts the stored value is a valid hash of the same plaintext.
      const loginRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "newuser@example.com", password: "plaintext-pw" })
        )
      )
      assert.strictEqual(loginRes.status, 200)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("GET /api/_schema — passes system annotations through instead of stripping them", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("schemaadmin@example.com", "secret")
      yield* Effect.flatMap(HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))), HttpServer.serveEffect())
      const loginRes = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "schemaadmin@example.com", password: "secret" })
        )
      )
      const token = ((yield* loginRes.json) as Record<string, unknown>)["token"] as string

      const res = yield* HttpClient.get("/api/_schema", {
        headers: { Authorization: `Bearer ${token}` }
      })
      assert.strictEqual(res.status, 200)
      const body = (yield* res.json) as Array<Record<string, unknown>>
      const users = body.find((s) => s["name"] === "users")
      assert.ok(users !== undefined)
      const fields = users["fields"] as Record<string, Record<string, unknown>>
      assert.strictEqual(fields["password"]?.["x-kind"], "password")
      assert.strictEqual(fields["password"]?.["x-hidden"], true)
      assert.strictEqual(fields["id"]?.["x-generated"], true)
      assert.strictEqual(fields["seqId"]?.["x-generated"], true)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("admin token bypasses rules; non-admin and anonymous are forbidden", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("admin@example.com", "secret", "_superadmin")

      // `restricted` has no rules at all → deny-all for non-admins
      const repo = yield* Repository
      const record = yield* repo.create("restricted", { name: "secret" }).pipe(Effect.orDie)

      yield* Effect.flatMap(
        HttpRouter.toHttpEffect(
          HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS, ADMIN_COLLECTIONS))
        ),
        HttpServer.serveEffect()
      )

      const adminLogin = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/_superadmin/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "admin@example.com", password: "secret" })
        )
      )
      assert.strictEqual(adminLogin.status, 200)
      const adminToken = yield* tokenFromLogin(yield* adminLogin.json)

      const adminPatch = yield* HttpClient.execute(
        HttpClientRequest.patch(`/api/collections/restricted/${record["id"]}`).pipe(
          HttpClientRequest.bearerToken(adminToken),
          HttpClientRequest.bodyJsonUnsafe({ name: "edited" })
        )
      )
      assert.strictEqual(adminPatch.status, 200)
      const updatedBody: unknown = yield* adminPatch.json
      if (!isRecord(updatedBody)) return yield* Effect.die("expected JSON object patch response")
      assert.strictEqual(updatedBody["name"], "edited")

      const ownerId = yield* seedUser("owner@example.com", "secret")
      const userLogin = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/users/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "owner@example.com", password: "secret" })
        )
      )
      assert.strictEqual(userLogin.status, 200)
      const userToken = yield* tokenFromLogin(yield* userLogin.json)
      assert.ok(ownerId.length > 0)

      const userPatch = yield* HttpClient.execute(
        HttpClientRequest.patch(`/api/collections/restricted/${record["id"]}`).pipe(
          HttpClientRequest.bearerToken(userToken),
          HttpClientRequest.bodyJsonUnsafe({ name: "nope" })
        )
      )
      assert.strictEqual(userPatch.status, 403)

      const anonPatch = yield* HttpClient.execute(
        HttpClientRequest.patch(`/api/collections/restricted/${record["id"]}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: "nope" })
        )
      )
      assert.strictEqual(anonPatch.status, 403)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("no admin collections configured means even the admin collection token is not admin", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* seedUser("admin2@example.com", "secret", "_superadmin")

      const repo = yield* Repository
      const record = yield* repo.create("restricted", { name: "still secret" }).pipe(Effect.orDie)

      yield* Effect.flatMap(
        HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))),
        HttpServer.serveEffect()
      )

      const adminLogin = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/_superadmin/auth-with-password").pipe(
          HttpClientRequest.bodyJsonUnsafe({ email: "admin2@example.com", password: "secret" })
        )
      )
      assert.strictEqual(adminLogin.status, 200)
      const adminToken = yield* tokenFromLogin(yield* adminLogin.json)

      const res = yield* HttpClient.execute(
        HttpClientRequest.patch(`/api/collections/restricted/${record["id"]}`).pipe(
          HttpClientRequest.bearerToken(adminToken),
          HttpClientRequest.bodyJsonUnsafe({ name: "nope" })
        )
      )
      assert.strictEqual(res.status, 403)
    }).pipe(Effect.provide(testLayer))
  )
})
