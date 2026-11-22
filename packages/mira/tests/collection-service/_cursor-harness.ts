import { SqliteClient } from "@effect/sql-sqlite-node"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import type { RepoRecord } from "@/repository/types.js"
import { FileStorage } from "@/storage/storage.js"

export const FileStorageTest = Layer.succeed(
  FileStorage,
  FileStorage.of({
    upload: (key) => Effect.succeed(key),
    delete: () => Effect.void,
    url: (key) => `/files/${key}`,
    read: () => Effect.die("unused"),
    exists: () => Effect.succeed(false),
    list: () => Effect.succeed([])
  })
)

export const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
export const DialectTest = Layer.succeed(Dialect, sqliteDialect)

export const noCtx: RequestCtx = { headers: {}, query: {} }

const postsDef = BaseCollection.define("posts", {
  title: Field.text(),
  published: Field.boolean({ default: false }),
  authorId: Field.text({ required: false })
})

const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

export const Posts = applyRulesToCollections([postsDef], [postsRules])[0]

export const setupPostsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"     INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"        TEXT NOT NULL UNIQUE,
      "title"     TEXT NOT NULL,
      "published" INTEGER NOT NULL DEFAULT 0,
      "authorId"  TEXT,
      "created"   TEXT NOT NULL,
      "updated"   TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "posts"`)
})

const withSeqId = (map: (row: RepoRecord) => unknown) =>
  Layer.effect(
    Repository,
    Effect.gen(function* () {
      const repo = yield* Repository
      return Repository.of({
        ...repo,
        list: (table, limit, options) =>
          Effect.map(repo.list(table, limit, options), (page) => ({
            items: page.items.map((row) => ({ ...row, seqId: map(row) }))
          }))
      })
    })
  ).pipe(
    Layer.provide(RepositoryLive),
    Layer.provide(sqliteLayer),
    Layer.provide(NodeCryptoLayer),
    Layer.provide(DialectTest)
  )

export const makeCursorServiceLayer = (map: (row: RepoRecord) => unknown) =>
  makeCollectionServiceLayer([Posts]).pipe(
    Layer.provide(withSeqId(map)),
    Layer.provide(sqliteLayer),
    Layer.provide(FileStorageTest),
    Layer.provide(NodeCryptoLayer),
    Layer.provide(DialectTest),
    Layer.provide(NodeAuthServiceLayer)
  )

export const makeCursorTestLayer = (map: (row: RepoRecord) => unknown) =>
  Layer.mergeAll(
    makeCursorServiceLayer(map),
    sqliteLayer,
    FileStorageTest,
    NodeCryptoLayer,
    DialectTest,
    NodeAuthServiceLayer
  )

export const makeRepositoryLayer = Layer.mergeAll(
  RepositoryLive.pipe(
    Layer.provide(sqliteLayer),
    Layer.provide(NodeCryptoLayer),
    Layer.provide(DialectTest)
  ),
  sqliteLayer,
  NodeCryptoLayer,
  DialectTest
)

/**
 * A repository that serves exact large `seqId` strings without asking the
 * SQLite driver to read an INTEGER above 2^53. The shipped SQLite driver throws
 * ERR_OUT_OF_RANGE for such rows, so the above-2^53 contract is tested here.
 */
export const makeFakeLargeRepositoryLayer = (
  rows: ReadonlyArray<{ id: string; title: string; seqId: string }>
) =>
  Layer.succeed(
    Repository,
    Repository.of({
      create: () => Effect.die("unused"),
      update: () => Effect.die("unused"),
      view: () => Effect.die("unused"),
      viewFilter: () => Effect.succeed([]),
      list: (_table, limit, options) => {
        const cursor = options?.where?.params.at(-1)
        const descending =
          options?.sort?.direction === "desc" || options?.where?.sql.includes("<") === true
        const filtered =
          cursor === undefined || cursor === null
            ? rows
            : rows.filter((row) =>
                descending
                  ? BigInt(row.seqId) < BigInt(String(cursor))
                  : BigInt(row.seqId) > BigInt(String(cursor))
              )
        const sorted = [...filtered].sort((a, b) => {
          const left = BigInt(a.seqId)
          const right = BigInt(b.seqId)
          const order = left < right ? -1 : left > right ? 1 : 0
          return descending ? -order : order
        })
        return Effect.succeed({ items: sorted.slice(0, limit) })
      },
      delete: () => Effect.die("unused")
    })
  )

export const makeFakeLargeCursorServiceLayer = (
  rows: ReadonlyArray<{ id: string; title: string; seqId: string }>
) =>
  makeCollectionServiceLayer([Posts]).pipe(
    Layer.provide(makeFakeLargeRepositoryLayer(rows)),
    Layer.provide(sqliteLayer),
    Layer.provide(FileStorageTest),
    Layer.provide(NodeCryptoLayer),
    Layer.provide(DialectTest),
    Layer.provide(NodeAuthServiceLayer)
  )
