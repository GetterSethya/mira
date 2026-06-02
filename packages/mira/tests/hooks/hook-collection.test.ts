import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { CollectionService, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import { makeHookCollectionServiceLayer } from "@/hooks/hook-collection.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import type { MiraPlugin } from "@/app/plugin.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text(),
}).rules((R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public(),
}))

const noCtx: RequestCtx = { headers: {}, query: {} }

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

const setupPostsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    seqId INTEGER,
    created TEXT,
    updated TEXT
  )`)
  yield* sql`INSERT INTO ${sql("posts")} ${sql.insert({ id: "1", title: "Hello", seqId: 1, created: "2024-01-01", updated: "2024-01-01" })}`
  yield* sql`INSERT INTO ${sql("posts")} ${sql.insert({ id: "2", title: "World", seqId: 2, created: "2024-01-02", updated: "2024-01-02" })}`
})

function makeTestLayer(plugins: ReadonlyArray<MiraPlugin>) {
  const innerService = makeCollectionServiceLayer([Posts]).pipe(
    Layer.provide(RepositoryLive),
    Layer.provide(sqliteLayer),
    Layer.provide(FileStorageTest),
    Layer.provide(NodeCryptoLayer),
  )
  return Layer.mergeAll(
    makeHookCollectionServiceLayer().pipe(
      Layer.provide(Layer.mergeAll(innerService, makeHookServiceLayer(plugins)))
    ),
    sqliteLayer,
    FileStorageTest,
    NodeCryptoLayer,
  )
}

describe("HookCollectionService", () => {
  it.effect("passes through to inner service when no hooks registered", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const page = yield* svc.list(Posts, null, 10, noCtx)
      expect(page.items.length).toBe(2)
      expect(page.items[0]["title"]).toBe("Hello")
    }).pipe(Effect.provide(makeTestLayer([])))
  )

  it.effect("intercepts create and modifies data via hook", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const record = yield* svc.create(Posts, { title: "Test" }, noCtx)
      expect(record["title"]).toBe("Hooked: Test")
    }).pipe(Effect.provide(makeTestLayer([{
      _tag: "MiraPlugin",
      onRecordCreate: {
        handler: (ctx) =>
          Effect.succeed({
            ...ctx,
            data: { ...ctx.data, title: "Hooked: " + ctx.data["title"] },
          }),
      },
    }])))
  )

  it.effect("intercepts list and modifies params via hook", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const page = yield* svc.list(Posts, null, 10, noCtx)
      expect(page.items.length).toBe(1)
    }).pipe(Effect.provide(makeTestLayer([{
      _tag: "MiraPlugin",
      onRecordList: {
        handler: (ctx) =>
          Effect.succeed({
            ...ctx,
            limit: 1,
          }),
      },
    }])))
  )

  it.effect("intercepts view and modifies select via hook", () =>
    Effect.gen(function* () {
      yield* setupPostsTable
      const svc = yield* CollectionService
      const record = yield* svc.view(Posts, "1", noCtx)
      expect(record["title"]).toBe("Hello")
    }).pipe(Effect.provide(makeTestLayer([{
      _tag: "MiraPlugin",
      onRecordView: {
        handler: (ctx) =>
          Effect.succeed({
            ...ctx,
            select: ["title"],
          }),
      },
    }])))
  )
})
