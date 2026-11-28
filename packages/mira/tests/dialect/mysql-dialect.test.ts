import { describe, expect, it } from "vitest"
import { Option } from "effect"

import {
  isMysqlDuplicateKey,
  isMysqlIgnorableBootstrapError,
  isMysqlRetryable,
  mysqlCastValue,
  mysqlCurrentTimestamp,
  mysqlIndexName,
  mysqlNativeType,
  mysqlQuoteIdentifier,
  mysqlQuoteLiteral,
  mysqlTimestampAdd,
  mysqlTimestampDiff,
  readMysqlAffectedRows
} from "@/dialect/dialect-mysql-core.js"
import { mysqlDialect, mysqlStoreSql, mysqlTelemetry } from "@/dialect/dialect-mysql.js"
import { makeRetentionDeleteStatement } from "@/telemetry/sql-store.js"

describe("mysql dialect", () => {
  it("composes the required members", () => {
    expect(mysqlDialect.placeholder(1)).toBe("?")
    expect(mysqlDialect.storesBooleanAsInteger).toBe(true)
    expect(mysqlDialect.deleteResult._tag).toBe("affectedRows")
    expect(mysqlDialect.transactionProbe).toBeDefined()
    expect(mysqlDialect.store).toBe(mysqlStoreSql)
    expect(mysqlDialect.telemetry).toBe(mysqlTelemetry)
    expect(mysqlDialect.normalizesBigintSeqId).toBeUndefined()
  })

  it("quotes identifiers and literals", () => {
    expect(mysqlQuoteIdentifier("a`b")).toBe("`a``b`")
    expect(mysqlQuoteLiteral(null)).toBe("NULL")
    expect(mysqlQuoteLiteral(undefined)).toBe("NULL")
    expect(mysqlQuoteLiteral(true)).toBe("TRUE")
    expect(mysqlQuoteLiteral(Number.NaN)).toBe("NULL")
    expect(mysqlQuoteLiteral("a\\b'c")).toBe("'a\\\\b''c'")
  })

  it("renders ISO timestamps with three fractional digits", () => {
    expect(mysqlCurrentTimestamp()).toContain("LEFT(DATE_FORMAT(UTC_TIMESTAMP(3)")
    expect(mysqlCurrentTimestamp()).toContain(", 23)")
    expect(mysqlCurrentTimestamp()).toContain("'Z'")
    expect(mysqlTimestampAdd("t.created", 90, "minute")).toContain("INTERVAL 90 MINUTE")
    expect(mysqlTimestampAdd("t.created", -1, "day")).toContain("INTERVAL -1 DAY")
    expect(mysqlTimestampDiff("a", "b", "hour")).toContain("/ 3600000000")
    expect(mysqlTimestampDiff("a", "b", "day")).toContain("/ 86400000000")
    expect(mysqlTimestampDiff("a", "b", "minute")).toContain("/ 60000000")
  })

  it("casts every field value type", () => {
    expect(mysqlCastValue("x", "text")).toBe("CAST(x AS CHAR)")
    expect(mysqlCastValue("x", "integer")).toBe("CAST(x AS SIGNED)")
    expect(mysqlCastValue("x", "bigint")).toBe("CAST(x AS SIGNED)")
    expect(mysqlCastValue("x", "number")).toBe("CAST(x AS DECIMAL(65,30))")
    expect(mysqlCastValue("x", "boolean")).toBe("CAST(x AS UNSIGNED)")
  })

  it("maps native types", () => {
    expect(mysqlNativeType({ name: "b", type: "boolean", nullable: false })).toBe("BOOLEAN")
    expect(
      mysqlNativeType({ name: "i", type: "integer", nullable: false, autoIncrement: true })
    ).toBe("BIGINT")
    expect(mysqlNativeType({ name: "i", type: "integer", nullable: false })).toBe("INT")
    expect(mysqlNativeType({ name: "r", type: "real", nullable: false })).toBe("DOUBLE")
    expect(mysqlNativeType({ name: "t", type: "text", nullable: false })).toBe("LONGTEXT")
    expect(
      mysqlNativeType({
        name: "t",
        type: "text",
        nullable: false,
        primaryKey: true,
        maxLength: 191
      })
    ).toBe("VARCHAR(191)")
  })

  it("names indexes deterministically", () => {
    expect(mysqlIndexName("posts", ["title"])).toBe("idx_posts_title")
    const longName = mysqlIndexName("x".repeat(100), ["y"])
    expect(longName.length).toBeLessThanOrEqual(64)
    expect(mysqlIndexName("x".repeat(100), ["y"])).toBe(longName)
  })

  it("reads the mysql2 affected-row header and rejects arrays", () => {
    expect(readMysqlAffectedRows({ affectedRows: 3 })).toEqual(Option.some(3))
    expect(readMysqlAffectedRows({ affectedRows: 0 })).toEqual(Option.some(0))
    expect(readMysqlAffectedRows([{ affectedRows: 2 }])).toEqual(Option.none())
    expect(readMysqlAffectedRows(null)).toEqual(Option.none())
    expect(readMysqlAffectedRows({ affectedRows: -1 })).toEqual(Option.none())
    expect(readMysqlAffectedRows({ affectedRows: 1.5 })).toEqual(Option.none())
  })

  it("classifies MySQL errors", () => {
    expect(isMysqlDuplicateKey({ errno: 1062 })).toBe(true)
    expect(isMysqlDuplicateKey({ errno: 1061 })).toBe(false)
    expect(isMysqlIgnorableBootstrapError({ errno: 1050 })).toBe(true)
    expect(isMysqlIgnorableBootstrapError({ errno: 1061 })).toBe(true)
    expect(isMysqlIgnorableBootstrapError({ errno: 1146 })).toBe(false)
    expect(isMysqlRetryable({ errno: 1205 })).toBe(true)
    expect(isMysqlRetryable({ errno: 3572 })).toBe(true)
    expect(isMysqlRetryable({ errno: 1062 })).toBe(false)
  })

  it("renders store clauses", () => {
    expect(mysqlStoreSql.insertIgnoreClause(["key"])).toBe(
      "ON DUPLICATE KEY UPDATE `key` = `key`"
    )
    expect(
      mysqlStoreSql.upsertClause(["key"], [{ column: "value", kind: "excluded" }])
    ).toBe("ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)")
    expect(
      mysqlStoreSql.upsertClause(
        ["collection", "user_id"],
        [{ column: "gen", kind: "increment-by-one" }]
      )
    ).toBe("ON DUPLICATE KEY UPDATE `gen` = `gen` + 1")
    expect(mysqlStoreSql.challengeLive.mode).toBe("generated")
    expect(mysqlStoreSql.challengeLive.indexName).toBe("_auth_challenges_live")
    expect(mysqlStoreSql.keyColumnType).toContain("utf8mb4_0900_bin")
    expect(mysqlStoreSql.bucketMaxLength).toBe(512)
    expect(mysqlStoreSql.mutationResult._tag).toBe("affectedRows")
  })

  it("renders the telemetry hooks", () => {
    expect(mysqlTelemetry.setup).toEqual([])
    expect(mysqlTelemetry.cleanup).toEqual([])
    expect(mysqlTelemetry.retryDml).toBe(true)
    expect(mysqlTelemetry.isDmlRetryable?.({ errno: 1205 })).toBe(true)
    expect(mysqlTelemetry.isDmlRetryable?.({ errno: 1213 })).toBe(false)
    expect(mysqlTelemetry.insertConflictClause?.("`id`")).toBe(
      "ON DUPLICATE KEY UPDATE `id` = `id`"
    )
    expect(mysqlTelemetry.insertConflictClause?.("`id`")).not.toContain(
      "ON CONFLICT"
    )

    const retention = makeRetentionDeleteStatement(
      mysqlDialect,
      "logs",
      false,
      "2026-11-25T00:00:00.000Z"
    )
    expect(retention.sql).toContain("DELETE FROM `logs`")
    expect(retention.sql).not.toContain("RETURNING")
    expect(retention.sql).not.toContain("PRAGMA")
  })
})