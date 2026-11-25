import { describe, it } from "@effect/vitest"
import { expect } from "vitest"

import {
  postgresDialect,
  postgresDdlSql,
  postgresFilterSql,
  postgresRuleSql,
  postgresStoreSql,
  postgresTelemetry
} from "@/dialect/dialect-postgres.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

const SQLITE_ESCAPE = "ESCAPE '\\'"
const POSTGRES_ESCAPE = String.raw`ESCAPE E'\\'`

describe("postgresDialect composition", () => {
  it("uses numbered placeholders, RETURNING deletes, and a select-only probe", () => {
    expect(postgresDialect.placeholder(1)).toBe("$1")
    expect(postgresDialect.placeholder(3)).toBe("$3")
    expect(postgresDialect.deleteResult).toEqual({ _tag: "returning" })
    expect(postgresDialect.transactionProbe).toBe("select-only")
  })

  it("normalizes bigint seqId values only on PostgreSQL", () => {
    expect(postgresDialect.normalizesBigintSeqId).toBe(true)
    expect(sqliteDialect.normalizesBigintSeqId).toBe(false)
  })

  it("spreads the PostgreSQL DDL and rule capabilities", () => {
    expect(postgresDialect.quoteLiteral).toBe(postgresDdlSql.quoteLiteral)
    expect(postgresDialect.translatePlan).toBe(postgresDdlSql.translatePlan)
    expect(postgresDialect.caseInsensitiveLike).toBe(postgresRuleSql.caseInsensitiveLike)
    expect(postgresDialect.caseInsensitivePattern).toBe(
      postgresFilterSql.caseInsensitivePattern
    )
    expect(postgresDialect.store).toBe(postgresStoreSql)
  })
})

describe("postgresDialect upsert", () => {
  it("renders an excluded-column update for non-conflict keys", () => {
    expect(
      postgresDialect.upsert("_collections", { name: "logs", schema: "{}" }, ["name"])
    ).toBe(
      'INSERT INTO "_collections" ("name", "schema") VALUES (E\'logs\', E\'{}\') ON CONFLICT ("name") DO UPDATE SET "schema" = excluded."schema"'
    )
  })

  it("falls back to DO NOTHING when every column is a conflict key", () => {
    expect(postgresDialect.upsert("_collections", { name: "logs" }, ["name"])).toBe(
      'INSERT INTO "_collections" ("name") VALUES (E\'logs\') ON CONFLICT ("name") DO NOTHING'
    )
  })

  it("renders the same statement shape as SQLite", () => {
    const record = { name: "logs", schema: "{}" }
    const postgres = postgresDialect.upsert("_collections", record, ["name"])
    const sqlite = sqliteDialect.upsert("_collections", record, ["name"])
    expect(postgres.replaceAll("E'", "'")).toBe(sqlite)
  })
})

describe("postgresDialect literal encoding", () => {
  it("renders text as an E-string with escaped quotes, backslashes, newlines, and Unicode", () => {
    expect(postgresDialect.quoteLiteral("it's")).toBe("E'it''s'")
    expect(postgresDialect.quoteLiteral(String.raw`a\b`)).toBe(String.raw`E'a\\b'`)
    expect(postgresDialect.quoteLiteral("line1\nline2")).toBe("E'line1\nline2'")
    expect(postgresDialect.quoteLiteral("héllo 😀")).toBe("E'héllo 😀'")
    expect(postgresDialect.quoteLiteral(String.raw`\'`)).toBe(String.raw`E'\\'''`)
  })

  it("leaves nulls, booleans, and numbers in their current forms", () => {
    expect(postgresDialect.quoteLiteral(null)).toBe("NULL")
    expect(postgresDialect.quoteLiteral(true)).toBe("TRUE")
    expect(postgresDialect.quoteLiteral(42)).toBe("42")
  })
})

describe("postgresDialect LIKE escape clause", () => {
  it("appends ESCAPE E'\\\\' to the PostgreSQL rule and filter renderers", () => {
    expect(
      postgresRuleSql.caseInsensitiveLike('t."title"', "$1", "prefix")
    ).toBe(`t."title" ILIKE ($1 || '%') ${POSTGRES_ESCAPE}`)
    expect(
      postgresRuleSql.caseInsensitiveLike('t."title"', "$1", "contains")
    ).toBe(`t."title" ILIKE ('%' || $1 || '%') ${POSTGRES_ESCAPE}`)
    expect(postgresFilterSql.caseInsensitivePattern('t."title"', "$1")).toBe(
      `t."title" ILIKE $1 ${POSTGRES_ESCAPE}`
    )
  })

  it("appends ESCAPE '\\' to the SQLite renderers", () => {
    expect(
      sqliteDialect.caseInsensitiveLike('t."title"', "?", "prefix")
    ).toBe(`t."title" LIKE (? || '%') ${SQLITE_ESCAPE}`)
    expect(
      sqliteDialect.caseInsensitiveLike('t."title"', "?", "contains")
    ).toBe(`t."title" LIKE ('%' || ? || '%') ${SQLITE_ESCAPE}`)
    expect(sqliteDialect.caseInsensitivePattern('t."title"', "?")).toBe(
      `t."title" LIKE ? ${SQLITE_ESCAPE}`
    )
  })
})

describe("postgresDialect bigint casts", () => {
  it("casts a bigint rule value and keeps the SQLite identity cast", () => {
    expect(postgresRuleSql.castValue('t."seqId"', "bigint")).toBe('t."seqId"::bigint')
    expect(sqliteDialect.castValue('t."seqId"', "bigint")).toBe('t."seqId"')
  })
})

describe("postgresDialect migration hooks", () => {
  it("pins READ COMMITTED, takes the advisory lock, then sets lock_timeout", () => {
    expect(postgresDialect.migrationTransactionSetupSql).toEqual([
      "SET LOCAL transaction_isolation = 'read committed'",
      "SELECT pg_advisory_xact_lock(hashtextextended('mira.migrations', 0))",
      "SET LOCAL lock_timeout = '5s'"
    ])
  })

  it("uses a non-blocking advisory preview lock for plan and status", () => {
    expect(postgresDialect.migrationPreviewLockSql).toBe(
      `SELECT pg_try_advisory_xact_lock(hashtextextended('mira.migrations', 0)) AS "acquired"`
    )
    expect(sqliteDialect.migrationTransactionSetupSql).toBeUndefined()
    expect(sqliteDialect.migrationPreviewLockSql).toBeUndefined()
  })

  it("prepends READ COMMITTED to the internal store bootstrap", () => {
    expect(postgresStoreSql.bootstrapMode).toBe("transaction")
    if (postgresStoreSql.bootstrapMode !== "transaction") return
    expect(postgresStoreSql.bootstrapSql[0]).toBe(
      "SET LOCAL transaction_isolation = 'read committed'"
    )
    expect(postgresStoreSql.bootstrapSql).toContain(
      "SELECT pg_advisory_xact_lock(hashtextextended('mira.system-tables', 0))"
    )
  })
})

describe("postgresDialect telemetry", () => {
  it("has no setup or cleanup and reuses the store retry predicate", () => {
    expect(postgresTelemetry.setup).toEqual([])
    expect(postgresTelemetry.cleanup).toEqual([])
    expect(postgresTelemetry.isRetryable).toBe(postgresStoreSql.isRetryable)
    expect(postgresDialect.telemetry).toBe(postgresTelemetry)
    expect(postgresTelemetry.isRetryable({ reason: { cause: { code: "40001" } } })).toBe(
      true
    )
    expect(postgresTelemetry.isRetryable({ code: "23505" })).toBe(false)
  })
})
