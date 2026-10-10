import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { AuthCollection, Field } from "@gettersethya/mira-client"
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

const usersDef = AuthCollection.define("users", {
  role: Field.literalText({ literal: ["admin", "user"] })
})

// create is public; update allows the owner OR an admin; manage grants admins
// manager access (email/emailVerified/password without oldPassword).
const usersRules = defineRule(usersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.or(
    R.field("id").eq(R.authId(usersDef)),
    R.auth(usersDef, "role").eq(R.literal("admin"))
  ),
  manage: R.auth(usersDef, "role").eq(R.literal("admin"))
}))
const Users = applyRulesToCollections([usersDef], [usersRules])[0]

const serviceLayer = makeCollectionServiceLayer([Users]).pipe(
  Layer.provide(RepositoryLive),
  Layer.provide(sqliteLayer),
  Layer.provide(FileStorageTest),
  Layer.provide(NodeCryptoLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)
const testLayer = Layer.mergeAll(serviceLayer, sqliteLayer, FileStorageTest, NodeCryptoLayer)

const setupUsersTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "users" (
      "seqId"         INTEGER PRIMARY KEY AUTOINCREMENT,
      "id"            TEXT NOT NULL UNIQUE,
      "email"         TEXT NOT NULL,
      "password"      TEXT NOT NULL,
      "emailVerified" INTEGER NOT NULL DEFAULT 0,
      "role"          TEXT NOT NULL DEFAULT 'user',
      "created"       TEXT NOT NULL,
      "updated"       TEXT NOT NULL
    )
  `)
  yield* sql`DELETE FROM ${sql("users")}`
})

const anonCtx: RequestCtx = { headers: {}, query: {} }
const adminCtx: RequestCtx = { headers: {}, query: {}, admin: true }
const asUser = (id: string, role: string): RequestCtx => ({
  headers: {},
  query: {},
  auth: { collection: "users", record: { id, role } }
})

function seedUser(email: string, password: string, role = "user") {
  return Effect.gen(function* () {
    const svc = yield* CollectionService
    return yield* svc.create(Users, { email, password, passwordConfirm: password, role }, adminCtx)
  })
}

function expectFailure(result: Result.Result<unknown, { _tag: string }>, tag: string) {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(result.failure._tag).toBe(tag)
}

describe("auth create credentials", () => {
  it.effect("create requires passwordConfirm to match password", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const svc = yield* CollectionService
      const result = yield* svc
        .create(Users, { email: "a@x.com", password: "secret", passwordConfirm: "different", role: "user" }, anonCtx)
        .pipe(Effect.result)
      expectFailure(result, "ValidationError")
    }).pipe(Effect.provide(testLayer)))

  it.effect("create with matching passwordConfirm succeeds and strips the hash", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const svc = yield* CollectionService
      const record = yield* svc.create(
        Users,
        { email: "b@x.com", password: "secret", passwordConfirm: "secret", role: "user" },
        anonCtx
      )
      expect(record["email"]).toBe("b@x.com")
      expect("password" in record).toBe(false)
    }).pipe(Effect.provide(testLayer)))

  it.effect("non-manage create cannot set emailVerified", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const svc = yield* CollectionService
      const result = yield* svc
        .create(
          Users,
          { email: "c@x.com", password: "secret", passwordConfirm: "secret", role: "user", emailVerified: true },
          anonCtx
        )
        .pipe(Effect.result)
      expectFailure(result, "ValidationError")
    }).pipe(Effect.provide(testLayer)))

  it.effect("admin ctx bypasses passwordConfirm", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const svc = yield* CollectionService
      const record = yield* svc.create(Users, { email: "d@x.com", password: "secret", role: "user" }, adminCtx)
      expect(record["email"]).toBe("d@x.com")
    }).pipe(Effect.provide(testLayer)))

  it.effect("manager (manage rule) create can set emailVerified", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const svc = yield* CollectionService
      const record = yield* svc.create(
        Users,
        { email: "e@x.com", password: "secret", passwordConfirm: "secret", role: "admin", emailVerified: true },
        asUser("manager-1", "admin")
      )
      expect(record["emailVerified"]).toBe(true)
    }).pipe(Effect.provide(testLayer)))
})

describe("auth update credentials", () => {
  it.effect("changing password without oldPassword is rejected", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const user = yield* seedUser("u1@x.com", "old-pw")
      const svc = yield* CollectionService
      const result = yield* svc
        .update(Users, String(user["id"]), { password: "new-pw", passwordConfirm: "new-pw" }, asUser(String(user["id"]), "user"))
        .pipe(Effect.result)
      expectFailure(result, "ValidationError")
    }).pipe(Effect.provide(testLayer)))

  it.effect("changing password with the wrong oldPassword is rejected", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const user = yield* seedUser("u2@x.com", "old-pw")
      const svc = yield* CollectionService
      const result = yield* svc
        .update(
          Users,
          String(user["id"]),
          { password: "new-pw", passwordConfirm: "new-pw", oldPassword: "wrong" },
          asUser(String(user["id"]), "user")
        )
        .pipe(Effect.result)
      expectFailure(result, "ValidationError")
    }).pipe(Effect.provide(testLayer)))

  it.effect("changing password with matching confirm + correct oldPassword succeeds", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const user = yield* seedUser("u3@x.com", "old-pw")
      const svc = yield* CollectionService
      const updated = yield* svc.update(
        Users,
        String(user["id"]),
        { password: "new-pw", passwordConfirm: "new-pw", oldPassword: "old-pw" },
        asUser(String(user["id"]), "user")
      )
      expect(updated["id"]).toBe(user["id"])
    }).pipe(Effect.provide(testLayer)))

  it.effect("changing email requires oldPassword", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const user = yield* seedUser("u4@x.com", "old-pw")
      const svc = yield* CollectionService
      const without = yield* svc
        .update(Users, String(user["id"]), { email: "u4-new@x.com" }, asUser(String(user["id"]), "user"))
        .pipe(Effect.result)
      expectFailure(without, "ValidationError")

      const withOld = yield* svc.update(
        Users,
        String(user["id"]),
        { email: "u4-new@x.com", oldPassword: "old-pw" },
        asUser(String(user["id"]), "user")
      )
      expect(withOld["email"]).toBe("u4-new@x.com")
    }).pipe(Effect.provide(testLayer)))

  it.effect("non-manage update cannot change emailVerified", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const user = yield* seedUser("u5@x.com", "old-pw")
      const svc = yield* CollectionService
      const result = yield* svc
        .update(Users, String(user["id"]), { emailVerified: true }, asUser(String(user["id"]), "user"))
        .pipe(Effect.result)
      expectFailure(result, "ValidationError")
    }).pipe(Effect.provide(testLayer)))

  it.effect("manager update can set emailVerified and change password without oldPassword", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const user = yield* seedUser("u6@x.com", "old-pw")
      const svc = yield* CollectionService
      const updated = yield* svc.update(
        Users,
        String(user["id"]),
        { password: "new-pw", passwordConfirm: "new-pw", emailVerified: true },
        asUser("manager-1", "admin")
      )
      expect(updated["emailVerified"]).toBe(true)
    }).pipe(Effect.provide(testLayer)))

  it.effect("unrelated field update needs no credentials", () =>
    Effect.gen(function* () {
      yield* setupUsersTable
      const user = yield* seedUser("u7@x.com", "old-pw")
      const svc = yield* CollectionService
      const updated = yield* svc.update(
        Users,
        String(user["id"]),
        { role: "admin" },
        asUser(String(user["id"]), "user")
      )
      expect(updated["role"]).toBe("admin")
    }).pipe(Effect.provide(testLayer)))
})
