import type { DialectType } from "@/dialect/dialect.js"

/** The single production DDL source for the `_config` system table. */
export const configTableDdl = (
  dialect: Pick<DialectType, "quoteIdentifier" | "store">
) => {
  const quote = dialect.quoteIdentifier
  return `CREATE TABLE IF NOT EXISTS ${quote("_config")} (${quote("key")} ${dialect.store.keyColumnType} PRIMARY KEY, ${quote("value")} ${dialect.store.textColumnType} NOT NULL)`
}