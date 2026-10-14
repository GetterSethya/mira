import { Effect } from "effect"

import type { TranslatePlanContext } from "./dialect.js"
import { translateStep } from "./dialect.js"
import type { DialectType } from "./dialect.js"
import { UnsupportedMigrationStepError } from "@/migrator/errors.js"
import type { ColumnDef, IndexShape, MigrationStep, TableShape, TableShapes } from "@/migrator/types.js"

/**
 * SQLite dialect implementation.
 * - Identifiers are double-quoted.
 * - Booleans are stored as INTEGER (0/1).
 * - `dropColumn` uses the native `ALTER TABLE … DROP COLUMN` (SQLite 3.35+).
 * - Changing an existing column's type/nullability/default has no in-place form:
 *   SQLite requires rebuilding the table, which `translatePlan` does by coalescing
 *   every column and index change of an affected table into one rebuild.
 */

/** Prefix of the scratch table a rebuild copies into before swapping it in. */
const REBUILD_PREFIX = "_mira_rebuild_"

/**
 * Steps a table rebuild subsumes, because the rebuild starts from the desired shape
 * and therefore already includes every column and index the plan asks for.
 */
const SUBSUMED_BY_REBUILD: ReadonlySet<MigrationStep["kind"]> = new Set([
  "addColumn",
  "alterColumn",
  "dropColumn",
  "createIndex",
  "dropIndex"
])

const quote = (name: string) => `"${name}"`

const quoteLiteral = (value: unknown) => {
  if (value === null) return "NULL"
  if (typeof value === "boolean") return value ? "1" : "0"
  if (typeof value === "number") return String(value)
  return `'${String(value).replace(/'/g, "''")}'`
}

const nativeTypeOf = (col: ColumnDef) => {
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
}

const indexNameOf = (table: string, fields: Array<string>) => `idx_${table}_${fields.join("_")}`

/** One column definition. Shared by `createTable`, `createSystemTable` and a rebuild's scratch table. */
function columnSql(col: ColumnDef) {
  if (col.autoIncrement) {
    return `${quote(col.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
  }
  const parts = [quote(col.name), nativeTypeOf(col)]
  if (!col.nullable) parts.push("NOT NULL")
  if (col.unique) parts.push("UNIQUE")
  if (col.default !== undefined) parts.push(`DEFAULT ${quoteLiteral(col.default)}`)
  if (col.primaryKey) parts.push("PRIMARY KEY")
  return parts.join(" ")
}

function createTableSql(table: string, columns: Array<ColumnDef>, ifNotExists = false) {
  const cols = columns.map(columnSql)
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quote(table)} (\n  ${cols.join(",\n  ")}\n)`
}

function createIndexSql(table: string, index: IndexShape) {
  const unique = index.unique ? "UNIQUE " : ""
  const cols = index.fields.map(quote).join(", ")
  return `CREATE ${unique}INDEX ${quote(indexNameOf(table, index.fields))} ON ${quote(table)} (${cols})`
}

/**
 * SQLite's procedure for changing a table's shape: create a scratch table with the
 * desired columns, copy the rows across, drop the original, rename the scratch table
 * into its place, then recreate the indexes.
 */
function rebuildStatements(table: string, desired: TableShape, stored: TableShape): Array<string> {
  const scratch = `${REBUILD_PREFIX}${table}`
  const previous = new Map(stored.columns.map((c) => [c.name, c]))
  const copied = desired.columns.filter((c) => previous.has(c.name))

  const statements = [
    `DROP TABLE IF EXISTS ${quote(scratch)}`,
    createTableSql(scratch, desired.columns)
  ]

  if (copied.length > 0) {
    const columns = copied.map((c) => quote(c.name)).join(", ")
    const projections = copied
      .map((c) => {
        const before = previous.get(c.name)
        // Selecting an explicit NULL does not apply a column's DEFAULT, so a column
        // that becomes NOT NULL with a default needs that default folded in.
        if (before?.nullable === true && !c.nullable && c.default !== undefined) {
          return `COALESCE(${quote(c.name)}, ${quoteLiteral(c.default)})`
        }
        return quote(c.name)
      })
      .join(", ")
    statements.push(`INSERT INTO ${quote(scratch)} (${columns}) SELECT ${projections} FROM ${quote(table)}`)
  }

  if (desired.columns.some((c) => c.autoIncrement === true)) {
    // Dropping a table deletes its `sqlite_sequence` row, which would let the rebuild
    // hand out ids that were already used. Move the row onto the scratch table first
    // so the rename carries the high-water mark over.
    statements.push(
      `DELETE FROM "sqlite_sequence" WHERE "name" = ${quoteLiteral(scratch)}`,
      `UPDATE "sqlite_sequence" SET "name" = ${quoteLiteral(scratch)} WHERE "name" = ${quoteLiteral(table)}`
    )
  }

  statements.push(
    `DROP TABLE ${quote(table)}`,
    `ALTER TABLE ${quote(scratch)} RENAME TO ${quote(table)}`
  )

  for (const index of desired.indexes) {
    statements.push(createIndexSql(table, index))
  }

  return statements
}

export const sqliteDialect: DialectType = {
  storesBooleanAsInteger: true,

  quoteIdentifier: quote,
  quoteLiteral,
  nativeType: nativeTypeOf,
  indexName: indexNameOf,

  translatePlan: (steps, ctx) =>
    Effect.gen(function* () {
      const rebuilds = new Map<string, TableShapes>()
      for (const step of steps) {
        if (step.kind !== "alterColumn") continue
        const shapes = ctx.tables.get(step.table)
        if (shapes === undefined || shapes.stored === null) {
          return yield* Effect.fail(
            new UnsupportedMigrationStepError({
              step: step.kind,
              detail: `changing a column of "${step.table}" requires rebuilding that table, but the plan carries no stored shape for it`
            })
          )
        }
        rebuilds.set(step.table, shapes)
      }

      const statements: Array<string> = []
      if (rebuilds.size > 0) {
        // Renaming a table makes SQLite ≥ 3.25 re-parse every view and trigger, so a
        // view that still references the table being swapped out fails the rename.
        // Legacy behaviour skips that pass; the migrator turns it back off once the
        // transaction is over, including when the transaction fails.
        statements.push("PRAGMA legacy_alter_table = ON")
      }

      const rebuilt = new Set<string>()
      for (const step of steps) {
        const table = "table" in step ? step.table : null
        const shapes = table === null ? undefined : rebuilds.get(table)

        if (
          table !== null &&
          shapes !== undefined &&
          shapes.stored !== null &&
          SUBSUMED_BY_REBUILD.has(step.kind)
        ) {
          if (!rebuilt.has(table)) {
            rebuilt.add(table)
            statements.push(...rebuildStatements(table, shapes.desired, shapes.stored))
          }
          continue
        }

        statements.push(...(yield* translateStep(sqliteDialect.translate, step)))
      }

      return {
        statements,
        cleanup: rebuilt.size > 0 ? ["PRAGMA legacy_alter_table = OFF"] : []
      }
    }),

  translate: (step) => {
    switch (step.kind) {
      case "createTable":
        return [createTableSql(step.table, step.columns)]

      case "dropTable":
        return [`DROP TABLE IF EXISTS ${quote(step.table)}`]

      case "renameTable":
        return [`ALTER TABLE ${quote(step.from)} RENAME TO ${quote(step.to)}`]

      case "addColumn": {
        const c = step.column
        const parts = [quote(c.name), nativeTypeOf(c)]
        if (!c.nullable) parts.push("NOT NULL")
        if (c.default !== undefined) {
          parts.push(`DEFAULT ${quoteLiteral(c.default)}`)
        } else if (!c.nullable) {
          // SQLite rejects ADD COLUMN NOT NULL without a DEFAULT when rows exist.
          const fallback: string | number = c.type === "text" ? "" : 0
          parts.push(`DEFAULT ${quoteLiteral(fallback)}`)
        }
        return [`ALTER TABLE ${quote(step.table)} ADD COLUMN ${parts.join(" ")}`]
      }

      case "dropColumn":
        // SQLite 3.35+ supports native column drops and preserves the table's
        // remaining columns and indexes (unlike the drop-and-recreate workaround).
        return [`ALTER TABLE ${quote(step.table)} DROP COLUMN ${quote(step.column)}`]

      case "renameColumn":
        return [
          `ALTER TABLE ${quote(step.table)} RENAME COLUMN ${quote(step.from)} TO ${quote(step.to)}`
        ]

      case "alterColumn":
        // Unreachable through `translatePlan`, which rebuilds the table instead:
        // this step alone does not carry the table's other columns or its indexes.
        return []

      case "createIndex":
        return [createIndexSql(step.table, { fields: step.fields, unique: step.unique })]

      case "dropIndex":
        return [`DROP INDEX IF EXISTS ${quote(indexNameOf(step.table, step.fields))}`]

      case "createSystemTable":
        return [createTableSql(step.table, step.columns, true)]

      case "createView":
        return [`CREATE VIEW IF NOT EXISTS ${quote(step.view)} AS ${step.query}`]

      case "dropView":
        return [`DROP VIEW IF EXISTS ${quote(step.view)}`]
    }
  }
}
