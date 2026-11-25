import type { CollectionSchema } from "@gettersethya/mira-client"
import type { Effect, LogLevel } from "effect"
import type { SqlError } from "effect/sql"

import type { ParameterizedStatement, TranslatePlanContext } from "@/dialect/dialect.js"

/** SQL column type at the database level. Maps from the JSON Schema `type` field. */
export type ColumnType = "text" | "integer" | "real" | "boolean"

/** Internal representation of a single database column, used when generating DDL. */
export type ColumnDef = {
  name: string
  type: ColumnType
  nullable: boolean
  default?: unknown
  primaryKey?: boolean
  autoIncrement?: boolean
  unique?: boolean
  xSystem?: boolean
  xHidden?: boolean
  xKind?: string
}

/** An index on a table: the fields it covers and whether it is unique. Dialects derive the SQL name from these. */
export type IndexShape = {
  fields: Array<string>
  unique: boolean
}

/** The physical shape of a table: its columns and its indexes. */
export type TableShape = {
  columns: Array<ColumnDef>
  indexes: Array<IndexShape>
}

/** What a table looks like now and what it should look like once a plan has run. */
export type TableShapes = {
  /** `null` when the table does not exist yet. */
  stored: TableShape | null
  desired: TableShape
}

/**
 * A single DDL operation produced by the schema differ.
 * Each variant maps 1:1 to a SQL statement via the active `Dialect`.
 */
export type MigrationStep =
  | { kind: "createTable"; table: string; columns: Array<ColumnDef> }
  | { kind: "dropTable"; table: string }
  | { kind: "renameTable"; from: string; to: string }
  | { kind: "addColumn"; table: string; column: ColumnDef }
  | { kind: "dropColumn"; table: string; column: string }
  | { kind: "renameColumn"; table: string; from: string; to: string }
  | { kind: "alterColumn"; table: string; from: ColumnDef; to: ColumnDef }
  | { kind: "createIndex"; table: string; fields: Array<string>; unique: boolean }
  | { kind: "dropIndex"; table: string; fields: Array<string>; unique: boolean }
  | { kind: "createSystemTable"; table: string; columns: Array<ColumnDef> }
  | { kind: "createView";        view: string; query: string }
  | { kind: "dropView";          view: string }

/** The full set of DDL steps to bring stored schemas up to date with desired schemas. */
export type MigrationPlan = {
  steps: Array<MigrationStep>
  /** True if any step would destroy data (drop table, drop column, alter column). */
  destructive: boolean
  /** Optional statement-level notes from the dialect, such as synthesized view operations. */
  notes?: ReadonlyArray<string>
}

/** A collection name paired with its desired `CollectionSchema`. Input to the migrator. */
export type NamedSchema = {
  name: string
  schema: CollectionSchema
}

/** Options controlling migration behavior passed to `Migrator.migrate()` and `Migrator.plan()`. */
export type MigrateOptions = {
  /** Allow destructive steps (drop table, drop column). Defaults to false. */
  allowDestructive?: boolean
  /** Numeric log verbosity: 0=none, 1=error, 2=warn, 3=info (default), 4=debug. */
  logLevel?: number
  /**
   * Table holding the stored collection schemas. Defaults to `_collections`.
   * Shared telemetry uses `_telemetry_collections` so the app migrator cannot
   * see or drop telemetry collections.
   */
  schemaTable?: string
  /**
   * Table holding applied migrations. Defaults to `_migrations`.
   * Shared telemetry uses `_telemetry_migrations`.
   */
  migrationsTable?: string
}

/**
 * The statement/query surface the migrator uses.
 *
 * Both modes build one: the transactional executor wraps the `SqlClient`, and
 * the statement executor wraps the reserved connection.
 */
export type MigrationExecutor = {
  readonly run: (statement: string) => Effect.Effect<void, SqlError.SqlError>
  readonly runParameterized: (
    statement: ParameterizedStatement
  ) => Effect.Effect<void, SqlError.SqlError>
  readonly query: TranslatePlanContext["readonlyQuery"]
}

/** A statement-mode executor that owns transaction control on one connection. */
export type MigrationRunner = MigrationExecutor & {
  readonly begin: () => Effect.Effect<void, SqlError.SqlError>
  readonly commit: () => Effect.Effect<void, SqlError.SqlError>
  readonly rollback: () => Effect.Effect<void, SqlError.SqlError>
}

/** Maps a numeric log level to an Effect `LogLevel`. Defaults to `Info` for unknown values. */
export function toEffectLogLevel(level?: number): LogLevel.LogLevel {
  switch (level ?? 3) {
    case 0: return "None"
    case 1: return "Error"
    case 2: return "Warn"
    case 3: return "Info"
    case 4: return "Debug"
    default: return "Info"
  }
}
