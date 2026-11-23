import { PgClient } from "@effect/sql-pg"
import { describe, it } from "@effect/vitest"
import { Data, Effect, Exit, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Dialect, errorHasCode, type DialectType } from "@/dialect/dialect.js"
import { postgresFilterSql, postgresRuleSql } from "@/dialect/dialect-postgres.js"
import { makeSqlTelemetryStoreLayer } from "@/telemetry/sql-store.js"
import { type TelemetryLogEntry, TelemetryStore } from "@/telemetry/store.js"

const postgresUrl = process.env["MIRA_TEST_POSTGRES_URL"]

const postgresTestDialect: DialectType = {
  ...postgresRuleSql,
  ...postgresFilterSql,
  translatePlan: () => Effect.succeed({ statements: [], cleanup: [] }),
  translate: () => [],
  nativeType: () => "text",
  quoteLiteral: (value) => {
    if (value === null) return "NULL"
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
    if (typeof value === "number") return String(value)
    return `'${String(value).replaceAll("'", "''")}'`
  },
  indexName: (table, fields) => `${table}_${fields.join("_")}_idx`,
  storesBooleanAsInteger: false,
  deleteResult: { _tag: "returning" },
  transactionProbe: "select-only",
  placeholder: (index) => `$${index}`,
  upsert: () => "",
  store: {
    bootstrapMode: "plain",
    columnExistsSql: (table, column) =>
      `SELECT 1 FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}' LIMIT 1`,
    isRetryable: (error) => errorHasCode(error, ["40P01", "40001"]),
    isDuplicateKey: (error) => errorHasCode(error, ["23505"]),
    transactionLockTimeoutSql: "SET LOCAL lock_timeout = '2s'"
  },
  telemetry: {
    setup: [],
    cleanup: [],
    isRetryable: (error) => errorHasCode(error, ["40P01", "40001"])
  }
}

const makeLayer = (url: string) =>
  makeSqlTelemetryStoreLayer({ dedicated: false, migrate: false }).pipe(
    Layer.provideMerge(
      Layer.merge(PgClient.layer({ url: Redacted.make(url) }), Layer.succeed(Dialect, postgresTestDialect))
    )
  )

// Local copy of the SQLite test fixture; test helpers are not exported.
const log = (id: string, message = id): TelemetryLogEntry => {
  const created = new Date().toISOString()
  return {
    id,
    level: "INFO",
    message,
    created,
    updated: created,
    traceId: null,
    spanId: null
  }
}

class RollbackError extends Data.TaggedError("RollbackError")<Record<string, never>> {}

const createLogsTable = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`DROP TABLE IF EXISTS "logs"`)
    yield* sql.unsafe(`
      CREATE TABLE "logs" (
        "seqId" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "id" text NOT NULL UNIQUE,
        "level" text NOT NULL,
        "message" text NOT NULL,
        "created" text NOT NULL,
        "updated" text NOT NULL,
        "traceId" text,
        "spanId" text
      )
    `)
  })

if (postgresUrl === undefined) {
  describe.skip("PostgreSQL shared telemetry", () => {
    it("requires MIRA_TEST_POSTGRES_URL", () => {})
  })
} else {
  const url = postgresUrl

  describe("PostgreSQL shared telemetry", () => {
    it.effect("keeps a caller transaction usable when appending duplicate ids", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* TelemetryStore

        yield* createLogsTable(sql)

        const constraints = yield* sql<{ column_name: string }>`
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          WHERE tc.table_name = 'logs'
            AND tc.table_schema = current_schema()
            AND tc.constraint_type = 'UNIQUE'
        `
        expect(constraints.map((row) => row.column_name)).toContain("id")

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.appendLogs([log("dup"), log("first")])
            yield* store.appendLogs([log("dup"), log("second")])
          })
        )

        const rows = yield* sql<{ id: string }>`SELECT "id" FROM "logs" ORDER BY "id"`
        expect(rows.map((row) => row.id)).toEqual(["dup", "first", "second"])
      }).pipe(Effect.provide(makeLayer(url)))
    )

    it.effect("rolls telemetry back with a direct caller transaction", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* TelemetryStore

        yield* createLogsTable(sql)

        const exit = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* store.appendLogs([log("rolled-back")])
              return yield* Effect.fail(new RollbackError({}))
            })
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        const rows = yield* sql<{ id: string }>`SELECT "id" FROM "logs"`
        expect(rows).toEqual([])
      }).pipe(Effect.provide(makeLayer(url)))
    )

    it.effect("matches mixed-case log messages with a dialect-aware like filter", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* TelemetryStore
        if (store.read === null) {
          throw new Error("expected the SQL telemetry store to expose reads")
        }
        const read = store.read

        yield* createLogsTable(sql)

        const collationRows = yield* sql<{ collation: string }>`
          SELECT datcollate || '|' || datctype || '|' || datlocprovider::text AS collation
          FROM pg_database
          WHERE datname = current_database()
        `
        const collation = collationRows.map((row) => row.collation).join(", ")

        yield* store.appendLogs([log("a", "Alpha"), log("b", "beta"), log("c", "GAMMA")])

        const ascii = yield* read.listLogs({
          limit: 10,
          after: null,
          filter: { op: "like", field: "message", value: "%a%" },
          traceId: null
        })
        expect(ascii.items.map((row) => row.id).sort(), `collation: ${collation}`).toEqual([
          "a",
          "b",
          "c"
        ])
        expect(ascii.total, `collation: ${collation}`).toBe(3)

        yield* store.appendLogs([log("pct", "100%"), log("x", "100x")])

        const escaped = yield* read.listLogs({
          limit: 10,
          after: null,
          filter: { op: "like", field: "message", value: "100\\%" },
          traceId: null
        })
        expect(escaped.items.map((row) => row.id), `collation: ${collation}`).toEqual(["pct"])

        const wildcard = yield* read.listLogs({
          limit: 10,
          after: null,
          filter: { op: "like", field: "message", value: "100%" },
          traceId: null
        })
        expect(wildcard.items.map((row) => row.id).sort(), `collation: ${collation}`).toEqual([
          "pct",
          "x"
        ])
      }).pipe(Effect.provide(makeLayer(url)))
    )
  })
}
