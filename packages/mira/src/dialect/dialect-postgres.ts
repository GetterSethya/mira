import type { TimestampUnit } from "@gettersethya/mira-client"

import type { FieldValueType, Quote, RuleSqlDialect, StoreSqlCapabilities } from "./dialect.js"
import { retryableByCauseCode } from "./dialect.js"

const quote: Quote = (name) => `"${name.replaceAll('"', '""')}"`

const isoFormat = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

const castValue = (expr: string, type: FieldValueType) =>
  `${expr}::${type === "number" ? "double precision" : type}`

const timestampAdd = (
  expr: string,
  amount: number,
  unit: TimestampUnit
) =>
  `to_char(((${expr})::timestamptz + interval '${amount} ${unit}') AT TIME ZONE 'UTC', ${isoFormat})`

const timestampDiff = (
  left: string,
  right: string,
  unit: TimestampUnit
): string => {
  const divisor = unit === "day" ? 86400 : unit === "hour" ? 3600 : 60
  return `(EXTRACT(EPOCH FROM ((${left})::timestamptz - (${right})::timestamptz)) / ${divisor})`
}

/**
 * PostgreSQL rule-SQL renderer. This is a pure capability object, not a
 * `DialectType` and not a database preset. #29 composes it into the full
 * PostgreSQL dialect.
 */
export const postgresRuleSql: RuleSqlDialect = {
  quoteIdentifier: quote,
  currentTimestamp: () =>
    `to_char(now() AT TIME ZONE 'UTC', ${isoFormat})`,
  timestampAdd,
  timestampDiff,
  caseInsensitiveLike: (left, right, mode) =>
    mode === "prefix"
      ? `${left} ILIKE (${right} || '%')`
      : `${left} ILIKE ('%' || ${right} || '%')`,
  castValue
}

const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

/**
 * Store capability for the future PostgreSQL dialect. It is intentionally a
 * capability object, not a full `DialectType`; #29 composes it.
 */
export const postgresStoreSql: StoreSqlCapabilities = {
  bootstrapMode: "transaction",
  bootstrapSql: [
    "SET LOCAL lock_timeout = '5s'",
    "SELECT pg_advisory_xact_lock(hashtextextended('mira.system-tables', 0))"
  ],
  columnExistsSql: (table, column) =>
    `SELECT 1 AS present FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ${quoteLiteral(table)}
       AND column_name = ${quoteLiteral(column)}
     LIMIT 1`,
  isRetryable: retryableByCauseCode(["40001", "40P01", "55P03"]),
  transactionLockTimeoutSql: "SET LOCAL lock_timeout = '2s'"
}
