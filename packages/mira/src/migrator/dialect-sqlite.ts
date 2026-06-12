import type { DialectType } from "./dialect.js"

/**
 * SQLite dialect implementation.
 * - Identifiers are double-quoted.
 * - Booleans are stored as INTEGER (0/1).
 * - `dropColumn` and `alterColumn` emit comment stubs — SQLite requires table recreation for these.
 */
export const sqliteDialect: DialectType = {
  quoteIdentifier: (name) => `"${name}"`,

  quoteLiteral: (value) => {
    if (value === null) return "NULL"
    if (typeof value === "boolean") return value ? "1" : "0"
    if (typeof value === "number") return String(value)
    return `'${String(value).replace(/'/g, "''")}'`
  },

  nativeType: (col) => {
    switch (col.type) {
      case "boolean":
        return "INTEGER"
      case "integer":
        return "INTEGER"
      case "real":
        return "REAL"
      case "text":
        return "TEXT"
    }
  },

  indexName: (table, fields) => `idx_${table}_${fields.join("_")}`,

  translate: (step) => {
    switch (step.kind) {
      case "createTable": {
        const cols = step.columns.map((col) => {
          if (col.autoIncrement) {
            return `${sqliteDialect.quoteIdentifier(col.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
          }
          const parts = [sqliteDialect.quoteIdentifier(col.name), sqliteDialect.nativeType(col)]
          if (!col.nullable) parts.push("NOT NULL")
          if (col.unique) parts.push("UNIQUE")
          if (col.default !== undefined) parts.push(`DEFAULT ${sqliteDialect.quoteLiteral(col.default)}`)
          if (col.primaryKey) parts.push("PRIMARY KEY")
          return parts.join(" ")
        })
        return [`CREATE TABLE ${sqliteDialect.quoteIdentifier(step.table)} (\n  ${cols.join(",\n  ")}\n)`]
      }

      case "dropTable":
        return [`DROP TABLE IF EXISTS ${sqliteDialect.quoteIdentifier(step.table)}`]

      case "renameTable":
        return [
          `ALTER TABLE ${sqliteDialect.quoteIdentifier(step.from)} RENAME TO ${sqliteDialect.quoteIdentifier(step.to)}`
        ]

      case "addColumn": {
        const c = step.column
        const parts = [sqliteDialect.quoteIdentifier(c.name), sqliteDialect.nativeType(c)]
        if (!c.nullable) parts.push("NOT NULL")
        if (c.default !== undefined) {
          parts.push(`DEFAULT ${sqliteDialect.quoteLiteral(c.default)}`)
        } else if (!c.nullable) {
          // SQLite rejects ADD COLUMN NOT NULL without a DEFAULT when rows exist.
          const fallback: string | number = c.type === "text" ? "" : 0
          parts.push(`DEFAULT ${sqliteDialect.quoteLiteral(fallback)}`)
        }
        return [`ALTER TABLE ${sqliteDialect.quoteIdentifier(step.table)} ADD COLUMN ${parts.join(" ")}`]
      }

      case "dropColumn":
        return [`-- dropColumn for ${step.column} requires table recreation`]

      case "renameColumn":
        return [
          `ALTER TABLE ${sqliteDialect.quoteIdentifier(step.table)} RENAME COLUMN ${sqliteDialect.quoteIdentifier(step.from)} TO ${sqliteDialect.quoteIdentifier(step.to)}`
        ]

      case "alterColumn":
        return [`-- alterColumn for ${step.column.name} requires table recreation`]

      case "createIndex": {
        const name = sqliteDialect.indexName(step.table, step.fields)
        const unique = step.unique ? "UNIQUE " : ""
        const cols = step.fields.map((f) => sqliteDialect.quoteIdentifier(f)).join(", ")
        return [
          `CREATE ${unique}INDEX ${sqliteDialect.quoteIdentifier(name)} ON ${sqliteDialect.quoteIdentifier(step.table)} (${cols})`
        ]
      }

      case "dropIndex":
        return [`DROP INDEX IF EXISTS ${sqliteDialect.quoteIdentifier(step.indexName)}`]

      case "createSystemTable": {
        const cols = step.columns.map((col) => {
          const parts = [sqliteDialect.quoteIdentifier(col.name), sqliteDialect.nativeType(col)]
          if (!col.nullable) parts.push("NOT NULL")
          if (col.primaryKey) parts.push("PRIMARY KEY")
          return parts.join(" ")
        })
        return [`CREATE TABLE IF NOT EXISTS ${sqliteDialect.quoteIdentifier(step.table)} (\n  ${cols.join(",\n  ")}\n)`]
      }

      case "createView":
        return [`CREATE VIEW IF NOT EXISTS ${sqliteDialect.quoteIdentifier(step.view)} AS ${step.query}`]

      case "dropView":
        return [`DROP VIEW IF EXISTS ${sqliteDialect.quoteIdentifier(step.view)}`]
    }
  }
}
