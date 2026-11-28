import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Data, Effect, Exit, Result } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import type { StoreSqlCapabilities } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { libsqlDialect } from "@/dialect/dialect-libsql.js"
import { postgresStoreSql } from "@/dialect/dialect-postgres.js"
import {
  ensureStoreColumn,
  ensureStoreIndex,
  withStoreBootstrap
} from "@/dialect/store-sql.js"

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

class TestError extends Data.TaggedError("TestError")<{ readonly retryable: boolean }> {}

const tableExists = (sql: SqlClient.SqlClient, name: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}
    `
    return rows.length > 0
  })

describe("withStoreBootstrap", () => {
  it.effect("runs plain DDL without a transaction or lock statement", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store: StoreSqlCapabilities = {
        ...sqliteDialect.store
      }

      yield* withStoreBootstrap(sql, store, (tx) =>
        tx.unsafe("CREATE TABLE _plain_probe (id INTEGER)").pipe(Effect.asVoid)
      )

      expect(yield* tableExists(sql, "_plain_probe")).toBe(true)
    }).pipe(Effect.provide(sqliteLayer))
  )

  it.effect("runs bootstrap SQL before the callback and commits both", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store: StoreSqlCapabilities = {
        ...sqliteDialect.store,
        bootstrapMode: "transaction",
        bootstrapSql: [
          "CREATE TABLE _bootstrap_gate (id INTEGER)",
          "INSERT INTO _bootstrap_gate (id) VALUES (1)"
        ]
      }

      yield* withStoreBootstrap(sql, store, (tx) =>
        Effect.gen(function* () {
          const gate = yield* tx<{ count: number }>`SELECT count(*) AS count FROM _bootstrap_gate`
          expect(Number(gate[0]?.count ?? 0)).toBe(1)
          yield* tx.unsafe("CREATE TABLE _callback_probe (id INTEGER)").pipe(Effect.asVoid)
        })
      )

      expect(yield* tableExists(sql, "_bootstrap_gate")).toBe(true)
      expect(yield* tableExists(sql, "_callback_probe")).toBe(true)
    }).pipe(Effect.provide(sqliteLayer))
  )

  it.effect("rolls back the DDL when the callback fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store: StoreSqlCapabilities = {
        ...sqliteDialect.store,
        bootstrapMode: "transaction",
        bootstrapSql: ["CREATE TABLE _rollback_gate (id INTEGER)"]
      }

      const exit = yield* Effect.exit(
        withStoreBootstrap(sql, store, (tx) =>
          Effect.gen(function* () {
            yield* tx.unsafe("CREATE TABLE _rollback_probe (id INTEGER)").pipe(Effect.asVoid)
            return yield* Effect.fail(new TestError({ retryable: false }))
          })
        )
      )

      expect(exit._tag).toBe("Failure")
      expect(yield* tableExists(sql, "_rollback_gate")).toBe(false)
      expect(yield* tableExists(sql, "_rollback_probe")).toBe(false)
    }).pipe(Effect.provide(sqliteLayer))
  )

  it.live("retries once for a retryable failure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      let attempts = 0
      const store: StoreSqlCapabilities = {
        ...sqliteDialect.store,
        bootstrapMode: "transaction",
        bootstrapSql: ["SELECT 1"],
        isRetryable: (error) => error instanceof TestError && error.retryable
      }

      yield* withStoreBootstrap(sql, store, (tx) =>
        Effect.gen(function* () {
          attempts += 1
          if (attempts === 1) {
            return yield* Effect.fail(new TestError({ retryable: true }))
          }
          yield* tx.unsafe("CREATE TABLE _retry_probe (id INTEGER)").pipe(Effect.asVoid)
        })
      )

      expect(attempts).toBe(2)
      expect(yield* tableExists(sql, "_retry_probe")).toBe(true)
    }).pipe(Effect.provide(sqliteLayer))
  )
})

describe("store capabilities", () => {
  it("SQLite uses plain bootstrap and the telemetry retry classifier", () => {
    expect(sqliteDialect.store.bootstrapMode).toBe("plain")
    expect(sqliteDialect.store.columnExistsSql("_rate_limits", "used")).toContain("pragma_table_info")
    expect(sqliteDialect.store.isRetryable).toBe(sqliteDialect.telemetry?.isRetryable)
  })

  it("PostgreSQL uses a transaction, advisory lock, and schema-qualified probe", () => {
    expect(postgresStoreSql.bootstrapMode).toBe("transaction")
    if (postgresStoreSql.bootstrapMode !== "transaction") return
    expect(postgresStoreSql.bootstrapSql.join("\n")).toContain("lock_timeout")
    expect(postgresStoreSql.bootstrapSql.join("\n")).toContain("pg_advisory_xact_lock")
    expect(postgresStoreSql.columnExistsSql("_auth_challenges", "new_email")).toContain(
      "current_schema()"
    )
    expect(postgresStoreSql.columnExistsSql("_auth_challenges", "new_email")).toContain("LIMIT 1")
    expect(postgresStoreSql.isRetryable({ code: "40001" })).toBe(true)
    expect(postgresStoreSql.isRetryable({ code: "40P01" })).toBe(true)
    expect(postgresStoreSql.isRetryable({ code: "55P03" })).toBe(true)
    expect(postgresStoreSql.isRetryable({ code: "23505" })).toBe(false)
    expect(postgresStoreSql.transactionLockTimeoutSql).toContain("2s")
  })
})

describe("ensureStoreIndex and ensureStoreColumn", () => {
  it.effect("ignores only classified bootstrap errors", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const lenient: StoreSqlCapabilities = {
        ...sqliteDialect.store,
        isIgnorableBootstrapError: () => true
      }
      yield* ensureStoreIndex(sql, lenient, "THIS IS NOT VALID SQL")

      const strict: StoreSqlCapabilities = {
        ...sqliteDialect.store,
        isIgnorableBootstrapError: () => false
      }
      const exit = yield* Effect.exit(
        ensureStoreIndex(sql, strict, "THIS IS NOT VALID SQL")
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }).pipe(Effect.provide(sqliteLayer))
  )

  it.effect("adds a missing column once and reports whether it ran", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe("CREATE TABLE _column_probe (id INTEGER)")

      const added = yield* ensureStoreColumn(
        sql,
        sqliteDialect.store,
        "_column_probe",
        "extra",
        "ALTER TABLE _column_probe ADD COLUMN extra TEXT"
      )
      expect(added).toBe(true)

      const again = yield* ensureStoreColumn(
        sql,
        sqliteDialect.store,
        "_column_probe",
        "extra",
        "ALTER TABLE _column_probe ADD COLUMN extra TEXT"
      )
      expect(again).toBe(false)
    }).pipe(Effect.provide(sqliteLayer))
  )
})

describe("duplicate key classifiers", () => {
  it.effect("classifies a real SQLite duplicate and rejects a NOT NULL error", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(`
        CREATE TABLE IF NOT EXISTS "_duplicate_email" (
          "email" TEXT NOT NULL UNIQUE
        )
      `)
      yield* sql.unsafe(`DELETE FROM "_duplicate_email"`)
      yield* sql.unsafe(`INSERT INTO "_duplicate_email" ("email") VALUES (?)`, ["a@example.com"])

      const duplicate = yield* Effect.result(
        sql.unsafe(`INSERT INTO "_duplicate_email" ("email") VALUES (?)`, ["a@example.com"])
      )
      expect(Result.isFailure(duplicate)).toBe(true)
      if (Result.isFailure(duplicate)) {
        expect(sqliteDialect.store.isDuplicateKey(duplicate.failure)).toBe(true)
        expect(sqliteDialect.store.isDuplicateKey(duplicate.failure.reason)).toBe(true)
      }

      const notNull = yield* Effect.result(
        sql.unsafe(`INSERT INTO "_duplicate_email" ("email") VALUES (?)`, [null])
      )
      expect(Result.isFailure(notNull)).toBe(true)
      if (Result.isFailure(notNull)) {
        expect(sqliteDialect.store.isDuplicateKey(notNull.failure)).toBe(false)
      }
    }).pipe(Effect.provide(sqliteLayer))
  )

  it("classifies structured codes without message text", () => {
    expect(sqliteDialect.store.isDuplicateKey({ errcode: 2067 })).toBe(true)
    expect(sqliteDialect.store.isDuplicateKey({ rawCode: 2067 })).toBe(true)
    expect(sqliteDialect.store.isDuplicateKey({ extendedCode: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(
      true
    )
    expect(sqliteDialect.store.isDuplicateKey({ reason: { _tag: "UniqueViolation" } })).toBe(true)
    expect(sqliteDialect.store.isDuplicateKey({ errstr: "constraint failed" })).toBe(false)

    expect(postgresStoreSql.isDuplicateKey({ code: "23505" })).toBe(true)
    expect(
      postgresStoreSql.isDuplicateKey({
        _tag: "SqlError",
        reason: { _tag: "UniqueViolation", cause: { code: "23505" } }
      })
    ).toBe(true)
    expect(
      postgresStoreSql.isDuplicateKey({ _tag: "SqlError", reason: { _tag: "UniqueViolation" } })
    ).toBe(true)
    expect(postgresStoreSql.isDuplicateKey({ code: "40P01" })).toBe(false)
    expect(
      postgresStoreSql.isDuplicateKey({
        message: "duplicate key value violates unique constraint"
      })
    ).toBe(false)

    expect(libsqlDialect("remote").store.isDuplicateKey({ errno: 2067 })).toBe(true)
  })
})
