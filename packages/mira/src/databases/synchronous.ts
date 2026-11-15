import { Context, Layer } from "effect"
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
 * Runs {@link applySynchronousMode} once, right after the SQLite connection
 * has been opened and before the layer is handed to the app.
 *
 * The pragma is per-connection, so it is applied through the `SqlClient`
 * produced by the driver layer itself (not a fresh connection). Layer
 * construction is the point at which the connection exists but no requests
 * have been served yet.
 *
 * Passing `undefined` leaves the driver default (`FULL`) untouched by issuing
 * no statement at all.
 */
export const withSynchronousMode = (
  layer: Layer.Layer<DatabaseServices, never, never>,
  mode: SqliteSynchronousMode | undefined
): Layer.Layer<DatabaseServices> =>
  mode === undefined
    ? layer
    : layer.pipe(
        Layer.tap((ctx) => applySynchronousMode(Context.get(ctx, SqlClient.SqlClient), mode)),
        Layer.orDie
      )
