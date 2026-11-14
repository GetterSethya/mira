import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"

import type { MiraDatabase } from "@/app/types.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

/**
 * SQLite database preset using `@effect/sql-sqlite-bun` (`bun:sqlite`).
 *
 * The SQL dialect, migrations, and internal tables are the same as the Node
 * preset. The Bun driver enables WAL and a busy timeout by default.
 *
 * @param config.filename - Path to the SQLite database file (`":memory:"` for tests)
 */
export const BunSqliteDatabase = (config: { filename: string }): MiraDatabase => ({
  layer: Layer.mergeAll(
    SqliteClient.layer({ filename: config.filename }).pipe(Layer.orDie),
    Layer.succeed(Dialect, sqliteDialect)
  )
})
