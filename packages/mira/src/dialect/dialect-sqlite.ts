import { Effect } from "effect"

import type { TranslatePlanContext } from "./dialect.js"
import { errorHasCode, translateStep } from "./dialect.js"
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

/** Prefix of the scratch table a rebuild copies into before recreating the original. */
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

const isSqliteBusy = (error: unknown) => errorHasCode(error, ["SQLITE_BUSY", "SQLITE_LOCKED"])

const isSqliteUniqueViolation = (error: unknown) =>
  errorHasCode(error, [
    "SQLITE_CONSTRAINT_PRIMARYKEY",
    "SQLITE_CONSTRAINT_UNIQUE",
    1555,
    2067
  ])

const upsertSql = (
  table: string,
  record: Readonly<Record<string, unknown>>,
  conflictKeys: ReadonlyArray<string>
) => {
  const keys = Object.keys(record)
  const columns = keys.map(quote).join(", ")
  const values = keys.map((key) => quoteLiteral(record[key])).join(", ")
  const updates = keys
    .filter((key) => !conflictKeys.includes(key))
    .map((key) => `${quote(key)} = excluded.${quote(key)}`)
    .join(", ")
  const conflict = conflictKeys.map(quote).join(", ")
  return `INSERT INTO ${quote(table)} (${columns}) VALUES (${values}) ON CONFLICT (${conflict}) ${
    updates.length > 0 ? `DO UPDATE SET ${updates}` : "DO NOTHING"
  }`
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
function columnSql(col: ColumnDef, syntheticDefault = false) {
  if (col.autoIncrement) {
    return `${quote(col.name)} INTEGER PRIMARY KEY AUTOINCREMENT`
  }
  const parts = [quote(col.name), nativeTypeOf(col)]
  if (!col.nullable) parts.push("NOT NULL")
  if (col.unique) parts.push("UNIQUE")
  if (col.default !== undefined) {
    parts.push(`DEFAULT ${quoteLiteral(col.default)}`)
  } else if (syntheticDefault) {
    // Match ADD COLUMN: a new NOT NULL column without a default needs a value
    // for rows that already exist. The fallback is not part of the collection
    // schema, but the physical table must accept the copy.
    parts.push(`DEFAULT ${quoteLiteral(col.type === "text" ? "" : 0)}`)
  }
  if (col.primaryKey) parts.push("PRIMARY KEY")
  return parts.join(" ")
}

function createTableSql(
  table: string,
  columns: Array<ColumnDef>,
  ifNotExists = false,
  syntheticDefaults: ReadonlySet<string> = new Set()
) {
  const cols = columns.map((column) => columnSql(column, syntheticDefaults.has(column.name)))
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quote(table)} (\n  ${cols.join(",\n  ")}\n)`
}

function createIndexSql(table: string, index: IndexShape) {
  const unique = index.unique ? "UNIQUE " : ""
  const cols = index.fields.map(quote).join(", ")
  return `CREATE ${unique}INDEX ${quote(indexNameOf(table, index.fields))} ON ${quote(table)} (${cols})`
}

/**
 * Rejects a unique-index change that would collapse existing rows before the
 * rebuild starts. Only single-field unique indexes are rejected: a composite
 * index may still be unique through its other fields, and the transaction rolls
 * the index creation back if it is not.
 */
function validateUniqueChanges(
  steps: ReadonlyArray<MigrationStep>,
  ctx: TranslatePlanContext
): Effect.Effect<void, UnsupportedMigrationStepError> {
  return Effect.gen(function* () {
    for (const step of steps) {
      if (step.kind !== "addColumn" && step.kind !== "alterColumn") continue
      const shapes = ctx.tables.get(step.table)
      if (shapes === undefined || shapes.stored === null) continue
      const storedNames = new Set(shapes.stored.columns.map((column) => column.name))

      for (const index of shapes.desired.indexes) {
        if (!index.unique || index.fields.length !== 1) continue
        const field = index.fields[0]!

        if (step.kind === "addColumn" && step.column.name === field && !storedNames.has(field)) {
          return yield* Effect.fail(
            new UnsupportedMigrationStepError({
              step: step.kind,
              detail: `adding "${step.column.name}" to "${step.table}" cannot satisfy the single-field unique index "${indexNameOf(step.table, index.fields)}" because every existing row would receive the same value`
            })
          )
        }

        if (step.kind === "alterColumn" && step.to.name === field) {
          if (step.from.type !== step.to.type) {
            return yield* Effect.fail(
              new UnsupportedMigrationStepError({
                step: step.kind,
                detail: `changing the type of "${step.table}"."${field}" can collapse values in the single-field unique index "${indexNameOf(step.table, index.fields)}"`
              })
            )
          }
          if (step.from.nullable && !step.to.nullable && step.to.default !== undefined) {
            return yield* Effect.fail(
              new UnsupportedMigrationStepError({
                step: step.kind,
                detail: `making "${step.table}"."${field}" NOT NULL with a default can collapse NULL rows into one value in the single-field unique index "${indexNameOf(step.table, index.fields)}"`
              })
            )
          }
        }
      }
    }
  })
}

/**
 * SQLite's procedure for changing a table's shape.
 *
 * The table is recreated in place instead of renamed: remote libSQL rejects the
 * legacy-alter pragma and cannot rename a table while a view references it. The
 * drop/create/copy order is the same on every SQLite-family connection, so there
 * is one rebuild path to test.
 */
function rebuildStatements(table: string, desired: TableShape, stored: TableShape): Array<string> {
  const scratch = `${REBUILD_PREFIX}${table}`
  const previous = new Map(stored.columns.map((c) => [c.name, c]))
  const copied = desired.columns.filter((c) => previous.has(c.name))
  const storedNames = new Set(previous.keys())
  const syntheticDefaults = new Set(
    desired.columns
      .filter((c) => !storedNames.has(c.name) && !c.nullable && c.default === undefined)
      .map((c) => c.name)
  )

  const statements = [createTableSql(scratch, desired.columns, false, syntheticDefaults)]

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
    // Dropping the original deletes its `sqlite_sequence` row, which would let the
    // new table hand out ids that were already used. Move the high-water mark onto
    // the scratch table, then move it back before the scratch is dropped.
    statements.push(
      `DELETE FROM "sqlite_sequence" WHERE "name" = ${quoteLiteral(scratch)}`,
      `UPDATE "sqlite_sequence" SET "name" = ${quoteLiteral(scratch)} WHERE "name" = ${quoteLiteral(table)}`
    )
  }

  statements.push(
    `DROP TABLE ${quote(table)}`,
    createTableSql(table, desired.columns, false, syntheticDefaults)
  )

  if (copied.length > 0) {
    const columns = desired.columns.map((c) => quote(c.name)).join(", ")
    statements.push(`INSERT INTO ${quote(table)} (${columns}) SELECT ${columns} FROM ${quote(scratch)}`)
  }

  if (desired.columns.some((c) => c.autoIncrement === true)) {
    statements.push(
      `DELETE FROM "sqlite_sequence" WHERE "name" = ${quoteLiteral(table)}`,
      `UPDATE "sqlite_sequence" SET "name" = ${quoteLiteral(table)} WHERE "name" = ${quoteLiteral(scratch)}`
    )
  }

  statements.push(`DROP TABLE ${quote(scratch)}`)

  for (const index of desired.indexes) {
    statements.push(createIndexSql(table, index))
  }

  return statements
}

export const sqliteDialect: DialectType = {
  storesBooleanAsInteger: true,
  // SQLite 3.35+ supports DELETE ... RETURNING on both the Node and Bun drivers.
  deleteResult: { _tag: "returning" },

  quoteIdentifier: quote,
  quoteLiteral,
  nativeType: nativeTypeOf,
  indexName: indexNameOf,
  placeholder: () => "?",
  upsert: upsertSql,
  telemetry: {
    setup: [
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
      "PRAGMA busy_timeout = 5000"
    ],
    cleanup: ["PRAGMA wal_checkpoint(TRUNCATE)"],
    isRetryable: isSqliteBusy,
    isDuplicateKey: isSqliteUniqueViolation
  },

  translatePlan: (steps, ctx) =>
    Effect.gen(function* () {
      yield* validateUniqueChanges(steps, ctx)

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
        cleanup: []
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
