import { Context } from "effect"

import type { ColumnDef, MigrationStep } from "@/migrator/types.js"

/**
 * Interface a SQL dialect must implement to translate abstract `MigrationStep` values
 * into executable SQL strings and to handle quoting/naming conventions.
 */
export type DialectType = {
  /** Translates a single `MigrationStep` into one or more SQL statements. */
  translate: (step: MigrationStep) => string[]
  /** Returns the dialect's native SQL type keyword for a given `ColumnDef`. */
  nativeType: (col: ColumnDef) => string
  /** Wraps an identifier (table or column name) in dialect-appropriate quotes. */
  quoteIdentifier: (name: string) => string
  /** Serializes a literal value to a SQL-safe string. */
  quoteLiteral: (value: unknown) => string
  /** Produces a deterministic index name from a table name and field list. */
  indexName: (table: string, fields: string[]) => string
  /** Whether this dialect stores boolean columns as 0/1 integers (true for SQLite; false for dialects with a native boolean type, e.g. Postgres). */
  storesBooleanAsInteger: boolean
}

/** Effect `Context.Tag` for the active SQL dialect. Inject via `Layer.succeed(Dialect, sqliteDialect)`. */
export class Dialect extends Context.Tag("Dialect")<Dialect, DialectType>() {}
