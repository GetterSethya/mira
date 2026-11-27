/**
 * Gated MySQL 8.4 and MariaDB 11.4 retention suite (issue #70).
 *
 * Run against real engines:
 *
 *   $env:MIRA_TEST_MYSQL_URL = "mysql://root:mira@127.0.0.1:53307/mira_test"
 *   $env:MIRA_TEST_MARIADB_URL = "mysql://root:mira@127.0.0.1:53306/mira_test"
 *   pnpm --filter @gettersethya/mira exec vitest run tests/databases/mysql-retention.e2e.test.ts --no-file-parallelism
 *
 * Each case creates a temporary database and drops it in a finalizer. The
 * suites can share a server; they never touch a user table in mira_test.
 */
import { MysqlClient } from "@effect/sql-mysql2"
import { it as effectIt } from "@effect/vitest"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import mysql from "mysql2/promise"
import { describe, expect, it } from "vitest"

import type { DialectType } from "@/dialect/dialect.js"
import { Dialect } from "@/dialect/dialect.js"
import { mysqlMigrationDialect } from "@/dialect/dialect-mysql-migrations.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { makeSqlTelemetryStoreLayer } from "@/telemetry/sql-store.js"
import { type TelemetryStoreShape, TelemetryStore } from "@/telemetry/store.js"

type EngineConfig = {
  readonly label: "MySQL" | "MariaDB"
  readonly envUrl: string | undefined
  readonly fallbackUrl: string
}

const readMysqlAffectedRows = (raw: unknown): Option.Option<number> => {
  const candidate = Array.isArray(raw) ? raw[0] : raw
  if (typeof candidate !== "object" || candidate === null) return Option.none()
  const value = Reflect.get(candidate, "affectedRows")
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Option.some(value)
    : Option.none()
}

const mysqlRetentionDialect = {
  ...sqliteDialect,
  ...mysqlMigrationDialect,
  placeholder: () => "?",
  deleteResult: { _tag: "affectedRows", read: readMysqlAffectedRows },
  telemetry: {
    setup: [],
    cleanup: [],
    isRetryable: () => false,
    insertConflictClause: (quotedId: string) =>
      `ON DUPLICATE KEY UPDATE ${quotedId} = ${quotedId}`
  },
  transactionProbe: "select-only"
} satisfies DialectType

const mysqlReturningDialect = {
  ...mysqlRetentionDialect,
  deleteResult: { _tag: "returning" }
} satisfies DialectType

const log = (id: string, created: string) => ({
  id,
  level: "INFO",
  message: id,
  created,
  updated: created,
  traceId: null,
  spanId: null
})

const span = (id: string, created: string) => ({
  id,
  name: id,
  traceId: `trace-${id}`,
  spanId: `span-${id}`,
  parentSpanId: null,
  kind: "internal",
  durationMs: 1,
  status: "ok" as const,
  error: null,
  attributes: { id },
  created,
  updated: created
})

const old = "2026-11-20T00:00:00.000Z"
const cutoff = "2026-11-25T00:00:00.000Z"
const recent = "2026-11-26T00:00:00.000Z"

const adminUrl = (url: string) => {
  const parsed = new URL(url)
  parsed.pathname = "/mysql"
  return parsed.toString()
}

const databaseUrl = (url: string, name: string) => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

const createDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
      await connection.query(`CREATE DATABASE \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const dropDatabase = (url: string, name: string) =>
  Effect.promise(async () => {
    const connection = await mysql.createConnection(adminUrl(url))
    try {
      await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
    } finally {
      await connection.end()
    }
  })

const makeLayer = (url: string, dialect: DialectType) => {
  const base = MysqlClient.layer({
    url: Redacted.make(url),
    maxConnections: 2
  })
  const deps = Layer.merge(base, Layer.succeed(Dialect, dialect))
  return makeSqlTelemetryStoreLayer({
    dedicated: true,
    manageConnection: false,
    migrate: true
  }).pipe(Layer.provideMerge(deps))
}

const withEngine = <A, E>(
  url: string,
  label: string,
  dialect: DialectType,
  body: (
    store: TelemetryStoreShape,
    sql: SqlClient.SqlClient
  ) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const name =
        `mira_retention_${label.toLowerCase().replaceAll(" ", "_")}_` +
        `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      yield* Effect.acquireRelease(createDatabase(url, name), () => dropDatabase(url, name))
      const ctx = yield* Layer.build(makeLayer(databaseUrl(url, name), dialect))
      const store = Context.get(ctx, TelemetryStore)
      const sql = Context.get(ctx, SqlClient.SqlClient)
      return yield* body(store, sql).pipe(Effect.provide(ctx))
    })
  )

const remainingIds = (sql: SqlClient.SqlClient, table: "logs" | "spans") =>
  sql
    .unsafe<{ id: string }>(`SELECT \`id\` FROM \`${table}\` ORDER BY \`id\``)
    .pipe(Effect.map((rows) => rows.map((row) => row.id)))

const registerSuite = (config: EngineConfig) => {
  const enabled = config.envUrl !== undefined
  const describeSuite = enabled ? describe : describe.skip
  const url = config.envUrl ?? config.fallbackUrl

  describeSuite(`${config.label} retention`, () => {
    effectIt.effect(
      "deletes old logs and spans and keeps the cutoff row",
      () =>
        withEngine(url, config.label, mysqlRetentionDialect, (store, sql) =>
          Effect.gen(function* () {
            yield* store.appendLogs([
              log("old-log", old),
              log("recent-log", recent),
              log("cutoff-log", cutoff)
            ])
            yield* store.appendSpans([
              span("old-span", old),
              span("recent-span", recent),
              span("cutoff-span", cutoff)
            ])

            const deleted = yield* store.deleteOlderThan(cutoff)
            expect(deleted).toEqual({ logs: 1, spans: 1 })
            expect(yield* remainingIds(sql, "logs")).toEqual([
              "cutoff-log",
              "recent-log"
            ])
            expect(yield* remainingIds(sql, "spans")).toEqual([
              "cutoff-span",
              "recent-span"
            ])
          })
        ),
      120_000
    )

    effectIt.effect(
      "deletes a 2,500-row backlog in batches for both tables",
      () =>
        withEngine(url, config.label, mysqlRetentionDialect, (store, sql) =>
          Effect.gen(function* () {
            const oldLogs = Array.from({ length: 2_500 }, (_, index) =>
              log(`old-log-${index}`, old)
            )
            const oldSpans = Array.from({ length: 2_500 }, (_, index) =>
              span(`old-span-${index}`, old)
            )

            for (let index = 0; index < 2_500; index += 1_000) {
              yield* store.appendLogs(oldLogs.slice(index, index + 1_000))
              yield* store.appendSpans(oldSpans.slice(index, index + 1_000))
            }
            yield* store.appendLogs([log("recent-log", recent)])
            yield* store.appendSpans([span("recent-span", recent)])

            const deleted = yield* store.deleteOlderThan(cutoff)
            expect(deleted).toEqual({ logs: 2_500, spans: 2_500 })
            expect(yield* remainingIds(sql, "logs")).toEqual(["recent-log"])
            expect(yield* remainingIds(sql, "spans")).toEqual(["recent-span"])
          })
        ),
      120_000
    )

    effectIt.effect(
      "deletes by seqId above 2^53 and keeps the exact recent value",
      () =>
        withEngine(url, config.label, mysqlRetentionDialect, (store, sql) =>
          Effect.gen(function* () {
            const incrementRows = yield* sql.unsafe<{ inc: number | string }>(
              "SELECT @@auto_increment_increment AS inc"
            )
            const increment = BigInt(Number(incrementRows[0]?.inc ?? 1))
            const first = 9007199254740993n
            const second = first + increment

            yield* sql.unsafe(
              "ALTER TABLE `logs` AUTO_INCREMENT = 9007199254740993"
            )
            yield* store.appendLogs([
              log("big-old", old),
              log("big-recent", recent)
            ])

            const before = yield* sql.unsafe<{ seqId: string; id: string }>(
              "SELECT CAST(`seqId` AS CHAR) AS seqId, `id` FROM `logs` ORDER BY `seqId`"
            )
            expect(before).toEqual([
              { seqId: first.toString(), id: "big-old" },
              { seqId: second.toString(), id: "big-recent" }
            ])

            const deleted = yield* store.deleteOlderThan(cutoff)
            expect(deleted).toEqual({ logs: 1, spans: 0 })

            const after = yield* sql.unsafe<{ seqId: string; id: string }>(
              "SELECT CAST(`seqId` AS CHAR) AS seqId, `id` FROM `logs`"
            )
            expect(after).toEqual([
              { seqId: second.toString(), id: "big-recent" }
            ])
          })
        ),
      120_000
    )

    if (config.label === "MariaDB") {
      effectIt.effect(
        "deletes with RETURNING 1 on MariaDB",
        () =>
          withEngine(url, config.label, mysqlReturningDialect, (store, sql) =>
            Effect.gen(function* () {
              yield* store.appendLogs([
                log("old-log", old),
                log("recent-log", recent)
              ])
              yield* store.appendSpans([span("old-span", old)])

              const deleted = yield* store.deleteOlderThan(cutoff)
              expect(deleted).toEqual({ logs: 1, spans: 1 })
              expect(yield* remainingIds(sql, "logs")).toEqual(["recent-log"])
              expect(yield* remainingIds(sql, "spans")).toEqual([])
            })
          ),
        120_000
      )
    }
  })
}

describe("readMysqlAffectedRows", () => {
  it("reads the mysql2 ResultSetHeader object", () => {
    expect(readMysqlAffectedRows({ affectedRows: 3 })).toEqual(Option.some(3))
  })

  it("reads a one-element wrapper array defensively", () => {
    expect(readMysqlAffectedRows([{ affectedRows: 2 }])).toEqual(Option.some(2))
  })

  it("returns None for missing, non-integer, negative, or null values", () => {
    for (const raw of [null, undefined, {}, { affectedRows: 1.5 }, { affectedRows: -1 }]) {
      expect(Option.isNone(readMysqlAffectedRows(raw))).toBe(true)
    }
  })
})

registerSuite({
  label: "MySQL",
  envUrl: process.env["MIRA_TEST_MYSQL_URL"],
  fallbackUrl: "mysql://root:mira@127.0.0.1:53307/mira_test"
})

registerSuite({
  label: "MariaDB",
  envUrl: process.env["MIRA_TEST_MARIADB_URL"],
  fallbackUrl: "mysql://root:mira@127.0.0.1:53306/mira_test"
})
