import { SqliteClient } from "@effect/sql-sqlite-node"
import { Layer } from "effect"

import type { MiraDatabase } from "@/app/types.js"
import { withSynchronousMode } from "@/databases/synchronous.js"
import type { SqliteSynchronousMode } from "@/databases/synchronous.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

/**
 * SQLite database preset using `@effect/sql-sqlite-node`.
 *
 * Creates a `MiraDatabase` that provides both the SQLite `SqlClient`
 * and the `Dialect` (for schema generation). The layer uses `Layer.orDie`
 * to convert `ConfigError` into a runtime panic — if the config is wrong,
 * the server should not start.
 *
 * @param config.filename - Path to the SQLite database file (use `":memory:"` for testing)
 * @param config.synchronous - Optional durability mode, applied with
 *   `PRAGMA synchronous` immediately after the connection opens. Omit it to
 *   keep the driver default (`FULL`).
 *
 *   - `"FULL"` fsyncs after every transaction: durable across process crashes
 *     **and** power loss, but the slowest option.
 *   - `"NORMAL"` is durable across process crashes, but a power loss (or OS
 *     crash) can lose the most recent transactions. The database stays
 *     consistent, and it is a common production trade-off for write-heavy
 *     workloads.
 *   - `"OFF"` skips fsync entirely. Data can be lost or the database corrupted
 *     on power loss — never use it in production.
 *
 * @returns A MiraDatabase preset
 *
 * @example
 * Mira.builder()
 *   .database(SqliteDatabase({ filename: "data.db" }))
 *   // trade some durability for throughput:
 *   .database(SqliteDatabase({ filename: "data.db", synchronous: "NORMAL" }))
 *   // or for testing:
 *   .database(SqliteDatabase({ filename: ":memory:" }))
 *
 * @see MiraDatabase — the interface SqliteDatabase implements
 * @see SqliteSynchronousMode — durability modes and their trade-offs
 */
export const SqliteDatabase = (config: {
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
