import type { TimestampUnit } from "@gettersethya/mira-client"

import type { FieldValueType, Quote, RuleSqlDialect } from "./dialect.js"

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
