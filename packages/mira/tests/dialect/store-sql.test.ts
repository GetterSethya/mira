import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import type { StoreSqlCapabilities } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { postgresStoreSql } from "@/dialect/dialect-postgres.js"
import { withStoreBootstrap } from "@/dialect/store-sql.js"

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
        bootstrapMode: "plain",
        columnExistsSql: () => "SELECT 1 AS present LIMIT 0",
        isRetryable: () => false
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
        bootstrapMode: "transaction",
        bootstrapSql: [
          "CREATE TABLE _bootstrap_gate (id INTEGER)",
          "INSERT INTO _bootstrap_gate (id) VALUES (1)"
        ],
        columnExistsSql: () => "SELECT 1 AS present LIMIT 0",
        isRetryable: () => false
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
        bootstrapMode: "transaction",
        bootstrapSql: ["CREATE TABLE _rollback_gate (id INTEGER)"],
        columnExistsSql: () => "SELECT 1 AS present LIMIT 0",
        isRetryable: () => false
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
        bootstrapMode: "transaction",
        bootstrapSql: ["SELECT 1"],
        columnExistsSql: () => "SELECT 1 AS present LIMIT 0",
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
