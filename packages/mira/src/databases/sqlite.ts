import { SqliteClient } from "@effect/sql-sqlite-node"
import { Layer } from "effect"
import { Dialect } from "@/migrator/dialect.js"
import { sqliteDialect } from "@/migrator/dialect-sqlite.js"
import type { MiraDatabase } from "@/app/types.js"

/**
 * SQLite database preset using `@effect/sql-sqlite-node`.
 *
 * Creates a `MiraDatabase` that provides both the SQLite `SqlClient`
 * and the `Dialect` (for schema generation). The layer uses `Layer.orDie`
 * to convert `ConfigError` into a runtime panic — if the config is wrong,
 * the server should not start.
 *
 * @param config.filename - Path to the SQLite database file (use `":memory:"` for testing)
 * @returns A MiraDatabase preset
 *
 * @example
 * Mira.builder()
 *   .database(SqliteDatabase({ filename: "data.db" }))
 *   // or for testing:
 *   .database(SqliteDatabase({ filename: ":memory:" }))
 *
 * @see MiraDatabase — the interface SqliteDatabase implements
 */
export const SqliteDatabase = (config: { filename: string }): MiraDatabase => ({
  layer: Layer.mergeAll(
    SqliteClient.layer({ filename: config.filename }).pipe(Layer.orDie),
    Layer.succeed(Dialect, sqliteDialect),
  ),
})
