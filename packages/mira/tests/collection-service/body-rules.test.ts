import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer, Result } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { CollectionService, makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import type { CollectionError } from "@/collection-service/errors.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"

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

// Dummy auth collection — only its name/identity is used by R.authId(), never queried.
const usersDef = AuthCollection.define("users", {})
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

// Issue #13 repro: the create rule reads the submitted body field.
const tasksDef = BaseCollection.define("tasks", {
  title: Field.text(),
  user: Field.text({ required: false })
})
const tasksRules = defineRule(tasksDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.request("body", "user").eq(R.authId(usersDef)),
  update: R.public(),
  delete: R.public()
}))

// Update rule compares the effective post-write body value against the stored row.
const notesDef = BaseCollection.define("notes", {
  title: Field.text(),
  ownerId: Field.text({ required: false })
})
const notesRules = defineRule(notesDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.request("body", "ownerId").eq(R.field("ownerId")),
  delete: R.public()
}))

const [Users, Tasks, Notes] = applyRulesToCollections(
  [usersDef, tasksDef, notesDef],
  [usersRules, tasksRules, notesRules]
)

const serviceLayer = makeCollectionServiceLayer([Users, Tasks, Notes]).pipe(
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
    CREATE TABLE IF NOT EXISTS "tasks" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "user"    TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "tasks"`)
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "notes" (
      "seqId"   INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"      TEXT NOT NULL UNIQUE,
      "title"   TEXT NOT NULL,
      "ownerId" TEXT,
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "notes"`)
})

const anonCtx: RequestCtx = { headers: {}, query: {} }
const asUser = (id: string): RequestCtx => ({
  headers: {},
  query: {},
  auth: { collection: "users", record: { id } }
})

function expectForbidden(result: Result.Result<unknown, CollectionError>, action: string) {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("ForbiddenError")
    if (result.failure._tag === "ForbiddenError") {
      expect(result.failure.action).toBe(action)
    }
  }
}

describe("body rules on create", () => {
  it.effect("allows a payload whose body field matches the authenticated user", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const record = yield* svc.create(Tasks, { title: "Mine", user: "u1" }, asUser("u1"))
      expect(record["title"]).toBe("Mine")
      expect(record["user"]).toBe("u1")
    }).pipe(Effect.provide(testLayer)))

  it.effect("403s a payload whose body field does not match the authenticated user", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const result = yield* svc.create(Tasks, { title: "Theirs", user: "someone-else" }, asUser("u1")).pipe(Effect.result)
      expectForbidden(result, "create")
    }).pipe(Effect.provide(testLayer)))

  it.effect("403s when the body key is missing (resolves to null, fail closed)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const result = yield* svc.create(Tasks, { title: "No user" }, asUser("u1")).pipe(Effect.result)
      expectForbidden(result, "create")
    }).pipe(Effect.provide(testLayer)))

  it.effect("403s anonymous callers when the rule references auth", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const result = yield* svc.create(Tasks, { title: "Anon", user: "u1" }, anonCtx).pipe(Effect.result)
      expectForbidden(result, "create")
    }).pipe(Effect.provide(testLayer)))
})

describe("body rules on update", () => {
  it.effect("allows a patch that omits the body key when the stored value matches (fallback)", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const created = yield* svc.create(Notes, { title: "Original", ownerId: "u1" }, anonCtx)
      const id = created["id"]
      if (typeof id !== "string") {
        expect.unreachable("expected string id")
      }
      const updated = yield* svc.update(Notes, id, { title: "Renamed" }, anonCtx)
      expect(updated["title"]).toBe("Renamed")
      expect(updated["ownerId"]).toBe("u1")
    }).pipe(Effect.provide(testLayer)))

  it.effect("403s a patch that changes the body key away from the stored value", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const created = yield* svc.create(Notes, { title: "Original", ownerId: "u1" }, anonCtx)
      const id = created["id"]
      if (typeof id !== "string") {
        expect.unreachable("expected string id")
      }
      const result = yield* svc.update(Notes, id, { ownerId: "attacker" }, anonCtx).pipe(Effect.result)
      expectForbidden(result, "update")
    }).pipe(Effect.provide(testLayer)))

  it.effect("allows a patch that re-asserts the stored body value", () =>
    Effect.gen(function* () {
      yield* setupTables
      const svc = yield* CollectionService
      const created = yield* svc.create(Notes, { title: "Original", ownerId: "u1" }, anonCtx)
      const id = created["id"]
      if (typeof id !== "string") {
        expect.unreachable("expected string id")
      }
      const updated = yield* svc.update(Notes, id, { ownerId: "u1", title: "Edited" }, anonCtx)
      expect(updated["ownerId"]).toBe("u1")
    }).pipe(Effect.provide(testLayer)))
})
