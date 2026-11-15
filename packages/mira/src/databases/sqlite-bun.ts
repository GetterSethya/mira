import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"

import type { MiraDatabase } from "@/app/types.js"
import { withSynchronousMode } from "@/databases/synchronous.js"
import type { SqliteSynchronousMode } from "@/databases/synchronous.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

/**
 * SQLite database preset using `@effect/sql-sqlite-bun` (`bun:sqlite`).
 *
 * The SQL dialect, migrations, and internal tables are the same as the Node
 * preset. The Bun driver enables WAL and a busy timeout by default.
 *
 * @param config.filename - Path to the SQLite database file (`":memory:"` for tests)
 * @param config.synchronous - Optional durability mode, applied with
 *   `PRAGMA synchronous` immediately after the connection opens. Omit it to
 *   keep the driver default (`FULL`).
 *
 *   - `"FULL"` fsyncs after every transaction: durable across process crashes
 *     **and** power loss, but the slowest option.
 *   - `"NORMAL"` (the recommended production setting in WAL mode) is durable
 *     across process crashes, but a power loss or OS crash can lose the most
 *     recent transactions. The database file stays consistent.
 *   - `"OFF"` skips fsync entirely. A power loss can lose data or corrupt the
 *     database — never use it in production.
 *
 * @see SqliteSynchronousMode — durability modes and their trade-offs
 */
export const BunSqliteDatabase = (config: {
  filename: string
  synchronous?: SqliteSynchronousMode
}): MiraDatabase => ({
  layer: withSynchronousMode(
    Layer.mergeAll(
      SqliteClient.layer({ filename: config.filename }).pipe(Layer.orDie),
      Layer.succeed(Dialect, sqliteDialect)
    ),
    config.synchronous
  )
})
