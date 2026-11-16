import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { BaseCollection, Field, Rule } from "@gettersethya/mira-client"
import { Effect, Layer, Result } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { CollectionService, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"

const FileStorageTest = Layer.succeed(
  FileStorage,
  FileStorage.of({
    upload: (key) => Effect.succeed(key),
    delete: () => Effect.void,
    url: (key) => `/files/${key}`,
    read: (key) => Effect.fail(new FileStorageNotFound({ key })),
    exists: () => Effect.succeed(false),
    list: () => Effect.succeed([])
  })
)

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const DialectTest = Layer.succeed(Dialect, sqliteDialect)

const membersDef = BaseCollection.define("members", {
  teamId: Field.text({ required: true }),
  userId: Field.text({ required: true })
})
const membersRules = defineRule(membersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const Members = applyRulesToCollections([membersDef], [membersRules])[0]

const postsDef = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  teamId: Field.text({ required: true })
})
const postsRules = defineRule(postsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("teamId").in(
    R.subquery(Members, "teamId").where(Rule.field("userId").eq(Rule.literal("u1")))
  ),
  delete: R.public()
}))
const Posts = applyRulesToCollections([postsDef], [postsRules])[0]

const reservedDef = BaseCollection.define("reserved", {
  "__mira_access_rule": Field.text({ required: true })
})
const reservedRules = defineRule(reservedDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))
const Reserved = applyRulesToCollections([reservedDef], [reservedRules])[0]

const serviceLayer = makeCollectionServiceLayer([Members, Posts, Reserved]).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)
const testLayer = Layer.mergeAll(serviceLayer, sqliteLayer, FileStorageTest, NodeCryptoLayer)

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "members" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "teamId"  TEXT NOT NULL,
      "userId"  TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "posts" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "teamId"  TEXT NOT NULL,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "reserved" (
      "seqId"              INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"                 TEXT NOT NULL UNIQUE,
      "__mira_access_rule" TEXT NOT NULL,
      "created"            TEXT NOT NULL,
      "updated"            TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "members"`)
  yield* sql.unsafe(`DELETE FROM "posts"`)
  yield* sql.unsafe(`DELETE FROM "reserved"`)
})

const anonCtx: RequestCtx = { headers: {}, query: {} }

function expectTag(result: Result.Result<unknown, { _tag: string }>, tag: string) {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure._tag).toBe(tag)
}

describe("update access SQL", () => {
  it.effect("evaluates a subquery update rule inside the access SELECT", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      yield* svc.create(Members, { teamId: "t1", userId: "u1" }, anonCtx)
      const allowed = yield* svc.create(Posts, { title: "Allowed", teamId: "t1" }, anonCtx)
      const denied = yield* svc.create(Posts, { title: "Denied", teamId: "t2" }, anonCtx)

      const updated = yield* svc.update(Posts, String(allowed["id"]), { title: "Renamed" }, anonCtx)
      expect(updated["title"]).toBe("Renamed")

      const result = yield* svc.update(Posts, String(denied["id"]), { title: "Nope" }, anonCtx).pipe(
        Effect.result
      )
      expectTag(result, "ForbiddenError")

      const missing = yield* svc.update(Posts, "nosuchid123456", { title: "Nope" }, anonCtx).pipe(
        Effect.result
      )
      expectTag(missing, "NotFoundError")
    }).pipe(Effect.provide(testLayer)))

  it.effect("falls back when a collection field collides with the access alias prefix", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const created = yield* svc.create(Reserved, { "__mira_access_rule": "x" }, anonCtx)
      const updated = yield* svc.update(
        Reserved,
        String(created["id"]),
        { "__mira_access_rule": "y" },
        anonCtx
      )
      expect(updated["__mira_access_rule"]).toBe("y")
    }).pipe(Effect.provide(testLayer)))
})
