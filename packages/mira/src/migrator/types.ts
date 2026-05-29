import { LogLevel } from "effect"

import type { CollectionSchema } from "@gettersethya/mira-client"

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

/**
 * A single DDL operation produced by the schema differ.
 * Each variant maps 1:1 to a SQL statement via the active `Dialect`.
 */
export type MigrationStep =
  | { kind: "createTable"; table: string; columns: ColumnDef[] }
  | { kind: "dropTable"; table: string }
  | { kind: "renameTable"; from: string; to: string }
  | { kind: "addColumn"; table: string; column: ColumnDef }
  | { kind: "dropColumn"; table: string; column: string }
  | { kind: "renameColumn"; table: string; from: string; to: string }
  | { kind: "alterColumn"; table: string; column: ColumnDef }
  | { kind: "createIndex"; table: string; fields: string[]; unique: boolean }
  | { kind: "dropIndex"; table: string; indexName: string }
  | { kind: "createSystemTable"; table: string; columns: ColumnDef[] }
  | { kind: "createView";        view: string; query: string }
  | { kind: "dropView";          view: string }

/** The full set of DDL steps to bring stored schemas up to date with desired schemas. */
export type MigrationPlan = {
  steps: MigrationStep[]
  /** True if any step would destroy data (drop table, drop column, alter column). */
  destructive: boolean
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
}

/** Maps a numeric log level to an Effect `LogLevel`. Defaults to `Info` for unknown values. */
export function toEffectLogLevel(level?: number): LogLevel.LogLevel {
  switch (level ?? 3) {
    case 0: return LogLevel.None
    case 1: return LogLevel.Error
    case 2: return LogLevel.Warning
    case 3: return LogLevel.Info
    case 4: return LogLevel.Debug
    default: return LogLevel.Info
  }
}
