import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import type { DatabaseServices } from "@/app/types.js"

/**
 * SQLite `PRAGMA synchronous` durability mode.
 *
 * - `"FULL"` — fsync after every transaction. Durable across process crashes
 *   **and** power loss, at the cost of throughput.
 * - `"NORMAL"` — fsync at checkpoints in WAL mode. Durable across process
 *   crashes, but the most recent transactions can be lost if the machine loses
 *   power (the database itself stays consistent).
 * - `"OFF"` — skips fsync entirely. Fast, but unsafe for production: a power
 *   loss or OS crash can corrupt the database.
 */
export type SqliteSynchronousMode = "FULL" | "NORMAL" | "OFF"

/**
 * Sets the connection-level `PRAGMA synchronous` mode.
 *
 * SQLite's `PRAGMA` statement does not accept bound parameters, so the mode is
 * spliced in with `sql.literal` from a closed union — never user input.
 */
export const applySynchronousMode = (sql: SqlClient.SqlClient, mode: SqliteSynchronousMode) =>
  sql`PRAGMA synchronous = ${sql.literal(mode)}`

/**
 * Enables SQLite's write-ahead log. WAL is the required default for every
 * Mira database: readers do not block the writer, and the single serialized
 * connection no longer pays rollback-journal overhead for every read.
 *
 * The driver enables WAL on writable connections by default, but Mira issues
 * the pragma explicitly so the guarantee does not depend on a driver default
 * changing. `":memory:"` databases report `"memory"` and cannot use WAL.
 */
export const applyJournalMode = (sql: SqlClient.SqlClient) =>
  sql`PRAGMA journal_mode = WAL`

/**
 * Sets the connection-level foreign-key enforcement flag. SQLite's pragma does
 * not accept bound parameters, so the flag is spliced in with `sql.literal`
 * from a boolean.
 */
export const applyForeignKeys = (sql: SqlClient.SqlClient, enabled: boolean) =>
  sql`PRAGMA foreign_keys = ${sql.literal(enabled ? "ON" : "OFF")}`

/**
 * Sets the connection-level busy timeout in milliseconds. SQLite's pragma does
 * not accept bound parameters, so the value is spliced in with `sql.literal`
 * from a caller-provided number.
 */
export const applyBusyTimeout = (sql: SqlClient.SqlClient, milliseconds: number) =>
  sql`PRAGMA busy_timeout = ${sql.literal(String(milliseconds))}`

export interface SqlitePragmaOptions {
  /**
   * Durability mode. Omitted leaves the driver default (`FULL`) in place.
   */
  readonly synchronous?: SqliteSynchronousMode | undefined
  /**
   * Foreign-key enforcement. Omitted leaves the driver default in place.
   */
  readonly foreignKeys?: boolean | undefined
  /**
   * Busy timeout in milliseconds. Omitted leaves the driver default in place.
   */
  readonly busyTimeout?: number | undefined
}

/**
 * Applies Mira's SQLite connection pragmas once, right after the connection
 * has been opened and before the layer is handed to the app:
 *
 * 1. `PRAGMA journal_mode = WAL`
 * 2. `PRAGMA foreign_keys = ...` when configured
 * 3. `PRAGMA busy_timeout = ...` when configured
 * 4. `PRAGMA synchronous = ...` when configured
 *
 * The pragmas are per-connection, so they are applied through the `SqlClient`
 * produced by the driver layer itself (not a fresh connection). Layer
 * construction is the point at which the connection exists but no requests
 * have been served yet.
 */
export const applySqlitePragmas = (
  sql: SqlClient.SqlClient,
  options: SqlitePragmaOptions = {}
) =>
  Effect.gen(function* () {
    yield* applyJournalMode(sql)
    if (options.foreignKeys !== undefined) {
      yield* applyForeignKeys(sql, options.foreignKeys)
    }
    if (options.busyTimeout !== undefined) {
      yield* applyBusyTimeout(sql, options.busyTimeout)
    }
    if (options.synchronous !== undefined) {
      yield* applySynchronousMode(sql, options.synchronous)
    }
  })

export const withSqlitePragmas = (
  layer: Layer.Layer<DatabaseServices, never, never>,
  options: SqlitePragmaOptions = {}
): Layer.Layer<DatabaseServices> =>
  layer.pipe(
    Layer.tap((ctx) => applySqlitePragmas(Context.get(ctx, SqlClient.SqlClient), options)),
    Layer.orDie
  )
