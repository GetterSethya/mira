/**
 * Request-size hardening for multipart uploads.
 *
 * Covers the request-level budget (declared `Content-Length` + streaming byte
 * counter), the multipart part-count cap, the non-file field size cap, and the
 * per-file `x-maxSize` drain-then-422 path (including partial-file cleanup).
 *
 * Exercises the production `makeCollectionRouter` / `CollectionService` /
 * on-disk `FileStorage` paths.
 */
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { BaseCollection, Bytes, Field } from "@gettersethya/mira-client"
import { Effect, FileSystem, Layer, Option, Redacted } from "effect"
import type { HttpClientResponse } from "effect/http"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import {
  CONTENT_OVERHEAD_BYTES,
  GLOBAL_MAX_UPLOAD_BYTES
} from "@/http/files.js"
import { makeCollectionRouter } from "@/http/router.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { FileStorage, makeFileStorageLayer } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

// Relative to packages/mira (vitest cwd).
const TMP = "./tests/http/.tmp"
const ROOT = "./tests/http/.tmp/files-root"

const utf8 = new TextEncoder()

/** Request-level budget for the collection below (one 1 KiB file field). */
const BUDGET = Math.min(GLOBAL_MAX_UPLOAD_BYTES, CONTENT_OVERHEAD_BYTES + Bytes.fromKB(1))

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const docsDef = BaseCollection.define("docs", {
  title: Field.text(),
  attachment: Field.file({ required: false, maxSize: Bytes.fromKB(1) })
})
const docsRules = defineRule(docsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

const [Docs] = applyRulesToCollections([docsDef], [docsRules])
const ALL_COLLECTIONS = [Docs]

const JWT_SECRET = "test-upload-limits-secret"

const AppConfigTest = Layer.succeed(
  AppConfig,
  AppConfig.of({
    appName: "test",
    port: 8080,
    applicationUrl: "http://localhost:8080",
    jwtSecret: Redacted.make(JWT_SECRET),
    useS3: false,
    s3Config: Option.none(),
    logRetentionDays: 30
  })
)

// ---------------------------------------------------------------------------
// Test layer (real on-disk FileStorage)
// ---------------------------------------------------------------------------

const nodePlatform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const storageLayer = makeFileStorageLayer("local", { directory: ROOT }).pipe(Layer.provide(nodePlatform))
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

const testLayer = Layer.mergeAll(
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove the scratch tree so each test starts with empty storage. */
const resetTmp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  yield* fs.remove(TMP, { recursive: true, force: true }).pipe(Effect.orDie)
})

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
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

const serveRouter = Effect.flatMap(
  HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))),
  HttpServer.serveEffect()
)

const responseText = (res: HttpClientResponse.HttpClientResponse) =>
  res.text.pipe(Effect.orElseSucceed(() => ""))

const concatBytes = (chunks: ReadonlyArray<Uint8Array>) => {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const storageFileCount = Effect.gen(function* () {
  const storage = yield* FileStorage
  const keys = yield* storage.list("")
  return keys.length
})

// ---------------------------------------------------------------------------

describe("multipart upload limits", () => {
  it.effect("rejects a declared Content-Length over budget with 413 before reading", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter

      const boundary = "----mirauploadboundary"
      const pre = utf8.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="title"\r\n\r\n` +
          `hi\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="attachment"; filename="big.bin"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      )
      const post = utf8.encode(`\r\n--${boundary}--\r\n`)
      const body = concatBytes([pre, new Uint8Array(1_200_000), post])
      assert.ok(body.byteLength > BUDGET)

      // A buffered (non-stream) body lets the HTTP client declare an exact
      // `Content-Length`; a streamed body would be sent chunked instead and the
      // pre-check could not observe the declared size.
      const res = yield* HttpClient.execute(
        HttpClientRequest.post("/api/collections/docs").pipe(
          HttpClientRequest.bodyUint8Array(body, `multipart/form-data; boundary=${boundary}`)
        )
      )
      const text = yield* responseText(res)

      assert.strictEqual(res.status, 413)
      assert.ok(
        text.includes("Declared request size"),
        `expected the declared-length pre-check to fire, got: ${text}`
      )
      assert.strictEqual(yield* storageFileCount, 0)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects too many multipart parts with 413", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter

      const fd = new FormData()
      fd.append("title", "many")
      for (let i = 0; i < 70; i++) {
        fd.append(`extra${i}`, "x")
      }

      const res = yield* HttpClient.execute(
        HttpClientRequest.bodyFormData(HttpClientRequest.post("/api/collections/docs"), fd)
      )
      const text = yield* responseText(res)

      assert.strictEqual(res.status, 413)
      assert.ok(text.includes("Too many multipart parts"), `unexpected body: ${text}`)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects an over-long text field with 422", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter

      const fd = new FormData()
      fd.append("title", "a".repeat(128 * 1024))

      const res = yield* HttpClient.execute(
        HttpClientRequest.bodyFormData(HttpClientRequest.post("/api/collections/docs"), fd)
      )
      const text = yield* responseText(res)

      assert.strictEqual(res.status, 422)
      assert.ok(text.includes("limit"), `unexpected body: ${text}`)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("rejects a file over its own x-maxSize (under budget) with 422 and deletes the partial file", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter

      // 4 KiB file, 1 KiB per-file cap; request total stays far under budget,
      // so this exercises the drain-then-422 per-file path.
      const fileBytes = new Uint8Array(4 * 1024)
      const fd = new FormData()
      fd.append("title", "partial")
      fd.append("attachment", new Blob([fileBytes], { type: "application/octet-stream" }), "four-k.bin")

      const res = yield* HttpClient.execute(
        HttpClientRequest.bodyFormData(HttpClientRequest.post("/api/collections/docs"), fd)
      )
      const text = yield* responseText(res)

      assert.strictEqual(res.status, 422)
      assert.ok(text.includes("exceeds maximum size"), `unexpected body: ${text}`)
      assert.strictEqual(yield* storageFileCount, 0)
    }).pipe(Effect.provide(testLayer))
  )
})
