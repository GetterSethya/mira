import type { TimestampUnit } from "@gettersethya/mira-client"
import { Option } from "effect"

import type { ColumnDef } from "@/migrator/types.js"

import type { FieldValueType, Quote, RuleSqlDialect } from "./dialect.js"
import {
  errorHasCode,
  hasUniqueViolationReason,
  retryableByCauseCode
} from "./dialect.js"

/** MySQL and MariaDB cap identifiers at 64 code points. */
export const MYSQL_MAX_IDENTIFIER_CODE_POINTS = 64

export const mysqlQuoteIdentifier: Quote = (name) =>
  `\`${name.replaceAll("`", "``")}\``

export const mysqlQuoteLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL"
  }
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`
}

const codePointLength = (value: string) => [...value].length

const truncateCodePoints = (value: string, budget: number) =>
  [...value].slice(0, budget).join("")

const fnv1a64 = (value: string) => {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

/**
 * Deterministic index name. Names over 64 code points are truncated with a
 * stable 64-bit FNV-1a suffix; they are never rejected.
 */
export const mysqlIndexName = (
  table: string,
  fields: ReadonlyArray<string>
) => {
  const raw = `idx_${table}_${fields.join("_")}`
  if (codePointLength(raw) <= MYSQL_MAX_IDENTIFIER_CODE_POINTS) return raw

  const suffix = `_${fnv1a64(raw)}`
  const budget = MYSQL_MAX_IDENTIFIER_CODE_POINTS - codePointLength(suffix)
  return `${truncateCodePoints(raw, budget)}${suffix}`
}

export const mysqlCurrentTimestamp = () =>
  `CONCAT(LEFT(DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z')`

export const mysqlTimestampAdd = (
  expr: string,
  amount: number,
  unit: TimestampUnit
) => {
  const keyword = unit === "day" ? "DAY" : unit === "hour" ? "HOUR" : "MINUTE"
  return `CONCAT(LEFT(DATE_FORMAT(DATE_ADD(STR_TO_DATE(${expr}, '%Y-%m-%dT%H:%i:%s.%fZ'), INTERVAL ${amount} ${keyword}), '%Y-%m-%dT%H:%i:%s.%f'), 23), 'Z')`
}

export const mysqlTimestampDiff = (
  left: string,
  right: string,
  unit: TimestampUnit
): string => {
  const divisor =
    unit === "day" ? 86_400_000_000 : unit === "hour" ? 3_600_000_000 : 60_000_000
  return `(TIMESTAMPDIFF(MICROSECOND, STR_TO_DATE(${right}, '%Y-%m-%dT%H:%i:%s.%fZ'), STR_TO_DATE(${left}, '%Y-%m-%dT%H:%i:%s.%fZ')) / ${divisor})`
}

export const mysqlCastValue = (expr: string, type: FieldValueType) =>
  type === "text"
    ? `CAST(${expr} AS CHAR)`
    : type === "number"
      ? `CAST(${expr} AS DECIMAL(65,30))`
      : type === "boolean"
        ? `CAST(${expr} AS UNSIGNED)`
        : `CAST(${expr} AS SIGNED)`

export const mysqlNativeType = (col: ColumnDef) => {
  switch (col.type) {
    case "boolean":
      return "BOOLEAN"
    case "integer":
      return col.autoIncrement === true ? "BIGINT" : "INT"
    case "real":
      return "DOUBLE"
    case "text":
      return (col.primaryKey === true || col.unique === true) &&
        col.maxLength !== undefined
        ? `VARCHAR(${col.maxLength})`
        : "LONGTEXT"
  }
}

/** Reads the mysql2 ResultSetHeader object; arrays are not a driver shape. */
export const readMysqlAffectedRows = (
  raw: unknown
): Option.Option<number> => {
  if (typeof raw !== "object" || raw === null) return Option.none()
  const value = Reflect.get(raw, "affectedRows")
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Option.some(value)
    : Option.none()
}

export const isMysqlDuplicateKey = (error: unknown) =>
  errorHasCode(error, [1062, "ER_DUP_ENTRY"]) || hasUniqueViolationReason(error)

export const isMysqlIgnorableBootstrapError = (error: unknown) =>
  errorHasCode(error, [
    1050,
    1060,
    1061,
    "ER_TABLE_EXISTS_ERROR",
    "ER_DUP_FIELDNAME",
    "ER_DUP_KEYNAME"
  ])

export const isMysqlRetryable = retryableByCauseCode([
  1205,
  1213,
  3572,
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_NOWAIT"
])

/** Rule-SQL renderer for MySQL and MariaDB. */
export const mysqlRuleSql: RuleSqlDialect = {
  quoteIdentifier: mysqlQuoteIdentifier,
  currentTimestamp: mysqlCurrentTimestamp,
  timestampAdd: mysqlTimestampAdd,
  timestampDiff: mysqlTimestampDiff,
  caseInsensitiveLike: (left, right, mode) =>
    mode === "prefix"
      ? `LOWER(${left}) LIKE LOWER(CONCAT(${right}, '%'))`
      : `LOWER(${left}) LIKE LOWER(CONCAT('%', ${right}, '%'))`,
  castValue: mysqlCastValue
}