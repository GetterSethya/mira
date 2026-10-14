import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { assert, describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import type { Path, Scope } from "effect"
import { Effect, FileSystem, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, makeFileStorageLayer } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const usersDef = BaseCollection.define("users", { name: Field.text() })
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const docsDef = BaseCollection.define("docs", {
  title: Field.text(),
  body: Field.text({ required: false }),
  author: Field.relation(usersDef, { required: false }),
  avatar: Field.file({ required: false }),
  cover: Field.file(),
})
const docsRules = defineRule(docsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const [Users, Docs] = applyRulesToCollections([usersDef, docsDef], [usersRules, docsRules])

// Auth collection: `emailVerified` is a non-required but NOT NULL (`x-system`)
// column, so it must keep rejecting an explicit `null` instead of reaching the
// database as a NOT NULL violation.
const membersDef = AuthCollection.define("members", {})
const membersRules = defineRule(membersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))
const Members = applyRulesToCollections([membersDef], [membersRules])[0]

const ALL_COLLECTIONS = [Users, Docs, Members]

// ---------------------------------------------------------------------------
// Static config
// ---------------------------------------------------------------------------

const AppConfigTest = Layer.succeed(AppConfig, AppConfig.of({
  appName: "test",
  port: 8080,
  applicationUrl: "http://localhost:8080",
  jwtSecret: Redacted.make("test-null-clearing-secret"),
  useS3: false,
  s3Config: Option.none(),
  logRetentionDays: 30,
}))

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))
const DialectTest = Layer.succeed(Dialect, sqliteDialect)

function makeServerLayer(storageLayer: Layer.Layer<FileStorage, never, FileSystem.FileSystem | Path.Path>) {
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
    DialectTest
  )
}

/**
 * Spins up an in-memory Server + Repository pair backed by a real local
 * `FileStorage` rooted in a temp directory, so file-deletion side effects can be
 * asserted against the filesystem. The collection router is served before the
 * body runs so `HttpClient` requests are handled in-process.
 */
function withServer<A, E>(
  body: Effect.Effect<A, E, HttpClient.HttpClient | SqlClient.SqlClient | FileStorage | Scope.Scope>
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie)
    const storageLayer = makeFileStorageLayer("local", { directory: dir })
    return yield* Effect.gen(function* () {
      yield* Effect.flatMap(
        HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))),
        HttpServer.serveEffect()
      ).pipe(Effect.orDie)
      return yield* body
    }).pipe(Effect.provide(makeServerLayer(storageLayer)))
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const AVATAR_KEY = "avatar/key1.png"
const COVER_KEY = "cover/key1.png"
const THUMB_SPEC = "100x100"
const AVATAR_THUMB_KEY = `_thumbs/${AVATAR_KEY}/${THUMB_SPEC}`

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "users" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "name"    TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("users")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "docs" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "body"    TEXT,
      "author"  TEXT,
      "avatar"  TEXT,
      "cover"   TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("docs")}`
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "members" (
      "seqId"         INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"            TEXT NOT NULL UNIQUE,
      "email"         TEXT NOT NULL UNIQUE,
      "password"      TEXT NOT NULL,
      "emailVerified" INTEGER NOT NULL DEFAULT 0,
      "created"       TEXT NOT NULL,
      "updated"       TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("members")}`
})

const IdSchema = Schema.Struct({ id: Schema.String })

function seedAvatarWithThumb(fileKey: string) {
  return Effect.gen(function* () {
    const storage = yield* FileStorage
    yield* storage.upload(fileKey, Stream.fromArray([new Uint8Array([1, 2, 3])]), "image/png")
    yield* storage.upload(
      `_thumbs/${fileKey}/${THUMB_SPEC}`,
      Stream.fromArray([new Uint8Array([9])]),
      "image/png"
    )
  })
}

function createDoc(fields: Record<string, unknown>) {
  return Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.post("/api/collections/docs").pipe(
        HttpClientRequest.bodyJsonUnsafe({ title: "Doc", cover: COVER_KEY, ...fields })
      )
    )
    assert.strictEqual(res.status, 201)
    const { id } = yield* Schema.decodeUnknownEffect(IdSchema)(yield* res.json).pipe(Effect.orDie)
    return id
  })
}

function patchDoc(id: string, data: Record<string, unknown>) {
  return HttpClient.execute(
    HttpClientRequest.patch(`/api/collections/docs/${id}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(data)
    )
  )
}

function readDocColumn(id: string, column: "body" | "author" | "avatar" | "cover") {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ value: string | null }>`
      SELECT ${sql(column)} AS value FROM ${sql("docs")} WHERE id = ${id}
    `
    return rows[0]?.value ?? null
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clearing optional fields via null (issue #14)", () => {
  it.effect("clear optional file → 200, column NULL, stored object + thumbnails deleted", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        yield* seedAvatarWithThumb(AVATAR_KEY)
        const storage = yield* FileStorage
        assert.strictEqual(yield* storage.exists(AVATAR_KEY), true)

        const id = yield* createDoc({ avatar: AVATAR_KEY, body: "hello", author: "u1" })
        assert.deepStrictEqual(yield* storage.list(`_thumbs/${AVATAR_KEY}/`), [AVATAR_THUMB_KEY])

        const res = yield* patchDoc(id, { avatar: null })
        assert.strictEqual(res.status, 200)

        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ avatar: Schema.NullOr(Schema.String) })
        )(yield* res.json).pipe(Effect.orDie)
        assert.strictEqual(decoded.avatar, null)

        assert.strictEqual(yield* readDocColumn(id, "avatar"), null)
        assert.strictEqual(yield* storage.exists(AVATAR_KEY), false)
        assert.deepStrictEqual(yield* storage.list(`_thumbs/${AVATAR_KEY}/`), [])
      })
    )
  )

  it.effect("clear REQUIRED file with null → 422 and object untouched", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        const storage = yield* FileStorage
        yield* storage.upload(COVER_KEY, Stream.fromArray([new Uint8Array([7])]), "image/png")

        const id = yield* createDoc({})
        const res = yield* patchDoc(id, { cover: null })
        assert.strictEqual(res.status, 422)

        assert.strictEqual(yield* readDocColumn(id, "cover"), COVER_KEY)
        assert.strictEqual(yield* storage.exists(COVER_KEY), true)
      })
    )
  )

  it.effect("required file null is rejected on create too → 422", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        const res = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/docs").pipe(
            HttpClientRequest.bodyJsonUnsafe({ title: "Doc", cover: null })
          )
        )
        assert.strictEqual(res.status, 422)
      })
    )
  )

  it.effect("clear optional text with null → 200 and column NULL", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        const id = yield* createDoc({ body: "hello" })
        const res = yield* patchDoc(id, { body: null })
        assert.strictEqual(res.status, 200)
        assert.strictEqual(yield* readDocColumn(id, "body"), null)
      })
    )
  )

  it.effect("clear optional relation with null → 200 and column NULL", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        const id = yield* createDoc({ author: "user-1" })
        const res = yield* patchDoc(id, { author: null })
        assert.strictEqual(res.status, 200)
        assert.strictEqual(yield* readDocColumn(id, "author"), null)
      })
    )
  )

  it.effect("replacing a file still deletes the old object + thumbnails (regression)", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        yield* seedAvatarWithThumb(AVATAR_KEY)
        const storage = yield* FileStorage
        const id = yield* createDoc({ avatar: AVATAR_KEY })

        const res = yield* patchDoc(id, { avatar: "avatar/key2.png" })
        assert.strictEqual(res.status, 200)

        assert.strictEqual(yield* readDocColumn(id, "avatar"), "avatar/key2.png")
        assert.strictEqual(yield* storage.exists(AVATAR_KEY), false)
        assert.deepStrictEqual(yield* storage.list(`_thumbs/${AVATAR_KEY}/`), [])
      })
    )
  )

  it.effect("create with explicit null for an optional file stores NULL", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        const id = yield* createDoc({ avatar: null, body: null, author: null })
        assert.strictEqual(yield* readDocColumn(id, "avatar"), null)
        assert.strictEqual(yield* readDocColumn(id, "body"), null)
        assert.strictEqual(yield* readDocColumn(id, "author"), null)
      })
    )
  )

  it.effect("auth emailVerified null → 422 (NOT NULL column, not a 500)", () =>
    withServer(
      Effect.gen(function* () {
        yield* setupTables
        const createRes = yield* HttpClient.execute(
          HttpClientRequest.post("/api/collections/members").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              email: "member@example.com",
              password: "secret",
              passwordConfirm: "secret",
            })
          )
        )
        assert.strictEqual(createRes.status, 201)
        const { id } = yield* Schema.decodeUnknownEffect(IdSchema)(yield* createRes.json).pipe(Effect.orDie)

        const res = yield* HttpClient.execute(
          HttpClientRequest.patch(`/api/collections/members/${id}`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ emailVerified: null })
          )
        )
        assert.strictEqual(res.status, 422)
      })
    )
  )
})
