/**
 * Shared harness for the security regression suites.
 *
 * Boots the real `makeCollectionRouter` over an in-memory SQLite database with
 * the real `CollectionService`, `Repository`, auth service and (optionally) the
 * real on-disk `FileStorage`, so every test exercises the production code paths.
 *
 * Not a test file itself — no `*.test.ts` suffix, so vitest ignores it.
 */
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { hashPassword } from "@/http/auth.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound, makeFileStorageLayer } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

export const JWT_SECRET = "security-audit-secret"

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

// Auth collections are defined first so base-collection rules can reference
// their ids via `R.authId(...)`.
const usersDef = AuthCollection.define("users", {})
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId()),
}))

const superAdminDef = AuthCollection.define("_superadmin", {})
const superAdminRules = defineRule(superAdminDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

// Target of the relation. Owner-only read rules.
const privateProfilesDef = BaseCollection.define("private_profiles", {
  email: Field.text(),
  ssn: Field.text(),
  ownerId: Field.text(),
})
const privateProfilesRules = defineRule(privateProfilesDef, (R) => ({
  list: R.field("ownerId").eq(R.authId(usersDef)),
  view: R.field("ownerId").eq(R.authId(usersDef)),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
  content: Field.text({ required: false }),
  // x-hidden — must never appear in a response, but is still a schema property.
  internalNote: Field.text({ required: false, hidden: true }),
  attachment: Field.file({ required: false }),
  secretAttachment: Field.file({ protected: true, required: false }),
  profile: Field.relation(privateProfilesDef, { required: false }),
})
const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

export const [PrivateProfiles, Posts, Users, SuperAdmin] = applyRulesToCollections(
  [privateProfilesDef, postsDef, usersDef, superAdminDef],
  [privateProfilesRules, postsRules, usersRules, superAdminRules]
)

export const ALL_COLLECTIONS = [PrivateProfiles, Posts, Users, SuperAdmin]
export const ADMIN_COLLECTIONS = ["_superadmin"]

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const stubFileStorage = Layer.succeed(
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

export const AppConfigTest = Layer.succeed(
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

/**
 * Build the full test layer.
 *
 * @param storageDirectory when provided, use the real on-disk `FileStorage`
 *   rooted at that directory; otherwise an in-memory stub.
 */
export function makeSecurityLayer(storageDirectory?: string) {
  const nodePlatform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
  // Annotated so the layer's requirements are uniformly `never` regardless of
  // which storage branch is taken — otherwise the union leaks `FileSystem | Path`
  // into every `Effect.provide(makeSecurityLayer(...))` call site.
  const storageLayer: Layer.Layer<FileStorage> =
    storageDirectory === undefined
      ? stubFileStorage
      : makeFileStorageLayer("local", { directory: storageDirectory }).pipe(Layer.provide(nodePlatform))

  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
  const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))
  const DialectTest = Layer.succeed(Dialect, sqliteDialect)

  const collectionServiceWithDeps = makeCollectionServiceLayer(ALL_COLLECTIONS).pipe(
    Layer.provide(repoWithSql),
    Layer.provide(storageLayer),
    Layer.provide(sqliteLayer),
    Layer.provide(DialectTest),
    Layer.provide(NodeAuthServiceLayer)
  )

  return Layer.mergeAll(
    collectionServiceWithDeps,
    repoWithSql,
    storageLayer,
    sqliteLayer,
    ThumbnailServiceNoopLive,
    NodeHttpServer.layerTest,
    AppConfigTest,
    NodeCryptoLayer,
    NodeAuthServiceLayer,
    DialectTest,
    NodeFileSystem.layer,
    NodePath.layer
  )
}

// ---------------------------------------------------------------------------
// Table + seed helpers
// ---------------------------------------------------------------------------

const authTable = (name: string) => `
  CREATE TABLE IF NOT EXISTS "${name}" (
    "seqId"         INTEGER PRIMARY KEY AUTOINCREMENT,
    "id"            TEXT NOT NULL UNIQUE,
    "email"         TEXT NOT NULL UNIQUE,
    "password"      TEXT NOT NULL,
    "emailVerified" INTEGER NOT NULL DEFAULT 0,
    "created"       TEXT NOT NULL,
    "updated"       TEXT NOT NULL
  )
`

export const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(authTable("users"))
  yield* sql.unsafe(authTable("_superadmin"))
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "private_profiles" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "email"   TEXT NOT NULL,
      "ssn"     TEXT NOT NULL,
      "ownerId" TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"            INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"               TEXT NOT NULL UNIQUE,
      "title"            TEXT NOT NULL DEFAULT '',
      "content"          TEXT,
      "internalNote"     TEXT,
      "attachment"       TEXT,
      "secretAttachment" TEXT,
      "profile"          TEXT,
      "created"          TEXT NOT NULL,
      "updated"          TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("users")}`
  yield* sql`DELETE FROM ${sql("_superadmin")}`
  yield* sql`DELETE FROM ${sql("private_profiles")}`
  yield* sql`DELETE FROM ${sql("posts")}`
})

export function seedUser(email: string, plain: string, table = "users") {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const hash = yield* hashPassword(plain)
    const raw = yield* repo.create(table, { email, password: hash }).pipe(Effect.orDie)
    const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(raw).pipe(Effect.orDie)
    return id
  })
}

export function seedPost(data: Record<string, unknown>) {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const raw = yield* repo.create("posts", data).pipe(Effect.orDie)
    const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(raw).pipe(Effect.orDie)
    return id
  })
}

export function seedProfile(data: Record<string, unknown>) {
  return Effect.gen(function* () {
    const repo = yield* Repository
    const raw = yield* repo.create("private_profiles", data).pipe(Effect.orDie)
    const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(raw).pipe(Effect.orDie)
    return id
  })
}

// ---------------------------------------------------------------------------
// Router boot + auth helpers
// ---------------------------------------------------------------------------

/**
 * Install the production collection router on the in-process test HTTP server.
 * Pass `admin: true` to model an app that has a plugin-declared admin collection.
 */
export function serveRouter(opts?: { admin?: boolean }) {
  const admin = opts?.admin === true ? ADMIN_COLLECTIONS : []
  return Effect.flatMap(
    HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS, admin))),
    HttpServer.serveEffect()
  )
}

export function login(email: string, password: string, collection = "users") {
  return Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.post(`/api/collections/${collection}/auth-with-password`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ email, password })
      )
    )
    const body = yield* res.json
    const { token } = yield* Schema.decodeUnknownEffect(Schema.Struct({ token: Schema.String }))(body).pipe(
      Effect.orDie
    )
    return token
  })
}

export function del(path: string, token: string) {
  return HttpClient.execute(
    HttpClientRequest.delete(path).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  )
}

export function get(path: string, token?: string) {
  const req = HttpClientRequest.get(path)
  return HttpClient.execute(
    token === undefined ? req : req.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  )
}

export function postJson(path: string, body: unknown, token?: string) {
  const req = HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body))
  return HttpClient.execute(
    token === undefined ? req : req.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  )
}

export function patchJson(path: string, body: unknown, token?: string) {
  const req = HttpClientRequest.patch(path).pipe(HttpClientRequest.bodyJsonUnsafe(body))
  return HttpClient.execute(
    token === undefined ? req : req.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${token}`))
  )
}
