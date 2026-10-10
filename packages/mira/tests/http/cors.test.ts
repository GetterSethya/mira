import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import type { CorsConfig } from "@/http/cors.js"
import { defaultCorsConfig, makeCorsMiddleware } from "@/http/cors.js"
import { makeCollectionRouter } from "@/http/router.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
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

const [Posts] = applyRulesToCollections([postsDef], [postsRules])
const ALL_COLLECTIONS = [Posts, Restricted]

const AppConfigTest = Layer.succeed(AppConfig, AppConfig.of({
  appName: "test",
  port: 8080,
  applicationUrl: "http://localhost:8080",
  jwtSecret: Redacted.make("test-jwt-secret"),
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
  yield* sql`DELETE FROM ${sql("posts")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "restricted" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "name"    TEXT NOT NULL DEFAULT '',
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("restricted")}`
})

// Serve the collection router wrapped in the CORS middleware under test —
// the same composition MiraApp.buildLayer() uses (minus IP annotation).
function serveWithCors(config: CorsConfig) {
  const cors = makeCorsMiddleware(config)
  return Effect.flatMap(
    HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))),
    (app) => HttpServer.serveEffect(cors(app))
  )
}

function getWithOrigin(url: string, origin: string) {
  return HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("origin", origin),
    HttpClient.execute
  )
}

describe("CORS middleware", () => {
  it.effect("default config — GET with Origin reflects it and allows credentials", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors(defaultCorsConfig)
      const res = yield* getWithOrigin("/api/collections/posts", "http://localhost:3000")
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000")
      assert.strictEqual(res.headers["access-control-allow-credentials"], "true")
      assert.strictEqual(res.headers["vary"], "Origin")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("default config — GET without Origin sends no CORS header", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors(defaultCorsConfig)
      const res = yield* HttpClient.get("/api/collections/posts")
      assert.strictEqual(res.status, 200)
      assert.strictEqual(res.headers["access-control-allow-origin"], undefined)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("default config — OPTIONS preflight returns 204 with reflected origin + credentials", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors(defaultCorsConfig)
      const res = yield* HttpClientRequest.options("/api/collections/posts").pipe(
        HttpClientRequest.setHeader("origin", "http://localhost:3000"),
        HttpClientRequest.setHeader("access-control-request-method", "POST"),
        HttpClientRequest.setHeader("access-control-request-headers", "content-type, authorization"),
        HttpClient.execute
      )
      assert.strictEqual(res.status, 204)
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000")
      assert.strictEqual(res.headers["access-control-allow-credentials"], "true")
      assert.ok((res.headers["access-control-allow-methods"] ?? "").includes("POST"))
      // Default reflects the requested headers
      assert.ok((res.headers["access-control-allow-headers"] ?? "").includes("authorization"))
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("single allowed origin — echoes the configured origin (browser enforces match)", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors({ allowedOrigins: ["http://localhost:3000"] })
      const allowed = yield* getWithOrigin("/api/collections/posts", "http://localhost:3000")
      assert.strictEqual(allowed.headers["access-control-allow-origin"], "http://localhost:3000")
      assert.strictEqual(allowed.headers["vary"], "Origin")
      const denied = yield* getWithOrigin("/api/collections/posts", "http://evil.example.com")
      assert.strictEqual(denied.status, 200)
      // Single-origin mode always echoes the configured origin (Effect
      // semantics) — the browser still blocks evil.example.com because the
      // echoed origin does not match the requesting origin.
      assert.strictEqual(denied.headers["access-control-allow-origin"], "http://localhost:3000")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("multiple allowed origins — only listed origins are echoed", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors({ allowedOrigins: ["http://localhost:3000", "https://app.example.com"] })
      const first = yield* getWithOrigin("/api/collections/posts", "https://app.example.com")
      assert.strictEqual(first.headers["access-control-allow-origin"], "https://app.example.com")
      const denied = yield* getWithOrigin("/api/collections/posts", "http://other.example.com")
      assert.strictEqual(denied.headers["access-control-allow-origin"], undefined)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("predicate origins — only matching origins are echoed", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors({ allowedOrigins: (origin) => origin.endsWith(".example.com") })
      const allowed = yield* getWithOrigin("/api/collections/posts", "https://app.example.com")
      assert.strictEqual(allowed.headers["access-control-allow-origin"], "https://app.example.com")
      const denied = yield* getWithOrigin("/api/collections/posts", "http://localhost:3000")
      assert.strictEqual(denied.headers["access-control-allow-origin"], undefined)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("restricted preflight — allowed origin echoed, methods/headers honored", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors({
        allowedOrigins: ["http://localhost:3000"],
        allowedMethods: ["GET", "POST"],
        allowedHeaders: ["Content-Type", "Authorization"],
        maxAge: 600
      })
      const res = yield* HttpClientRequest.options("/api/collections/posts").pipe(
        HttpClientRequest.setHeader("origin", "http://localhost:3000"),
        HttpClientRequest.setHeader("access-control-request-method", "POST"),
        HttpClient.execute
      )
      assert.strictEqual(res.status, 204)
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000")
      assert.strictEqual(res.headers["access-control-allow-methods"], "GET, POST")
      assert.strictEqual(res.headers["access-control-allow-headers"], "Content-Type,Authorization")
      assert.strictEqual(res.headers["access-control-max-age"], "600")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("error responses carry CORS headers — 404 unknown collection", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors(defaultCorsConfig)
      const res = yield* getWithOrigin("/api/collections/no_such_collection", "http://localhost:3000")
      assert.strictEqual(res.status, 404)
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("error responses carry CORS headers — 403 denied by rules", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors(defaultCorsConfig)
      const res = yield* HttpClientRequest.post("/api/collections/restricted").pipe(
        HttpClientRequest.setHeader("origin", "http://localhost:3000"),
        HttpClientRequest.bodyJsonUnsafe({ name: "secret" }),
        HttpClient.execute
      )
      assert.strictEqual(res.status, 403)
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("credentials — sends allow-credentials with explicit origin", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors({ allowedOrigins: ["http://localhost:3000"], credentials: true })
      const res = yield* getWithOrigin("/api/collections/posts", "http://localhost:3000")
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000")
      assert.strictEqual(res.headers["access-control-allow-credentials"], "true")
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("exposed headers — sent on regular responses when configured", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serveWithCors({ exposedHeaders: ["X-Total-Count"] })
      const res = yield* getWithOrigin("/api/collections/posts", "http://localhost:3000")
      assert.strictEqual(res.headers["access-control-expose-headers"], "X-Total-Count")
    }).pipe(Effect.provide(testLayer))
  )
})

describe("makeCorsMiddleware validation", () => {
  it("wildcard origin with credentials throws", () => {
    expect(() => makeCorsMiddleware({ allowedOrigins: ["*"], credentials: true })).toThrow(
      "credentials: true requires explicit allowedOrigins"
    )
  })

  it("omitted origins with credentials throws", () => {
    expect(() => makeCorsMiddleware({ credentials: true })).toThrow(
      "credentials: true requires explicit allowedOrigins"
    )
  })

  it("empty origins with credentials throws", () => {
    expect(() => makeCorsMiddleware({ allowedOrigins: [], credentials: true })).toThrow(
      "credentials: true requires explicit allowedOrigins"
    )
  })

  it("explicit origin with credentials does not throw", () => {
    expect(() =>
      makeCorsMiddleware({ allowedOrigins: ["http://localhost:3000"], credentials: true })
    ).not.toThrow()
  })

  it("predicate origin with credentials does not throw", () => {
    expect(() =>
      makeCorsMiddleware({ allowedOrigins: () => true, credentials: true })
    ).not.toThrow()
  })
})
