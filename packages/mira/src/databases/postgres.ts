import { PgClient } from "@effect/sql-pg"
import type { Duration, Redacted } from "effect"
import { Context, Layer } from "effect"
import { SqlClient } from "effect/sql"

import type { DatabaseServices, MiraDatabase } from "@/app/types.js"
import { Dialect } from "@/dialect/dialect.js"
import { postgresDialect } from "@/dialect/dialect-postgres.js"

/** An invalid PostgreSQL preset configuration. Thrown before a layer is built. */
export class PostgresConfigError extends Error {
  readonly _tag = "PostgresConfigError"

  constructor(message: string) {
    super(message)
    this.name = "PostgresConfigError"
  }
}

export interface PostgresDatabaseConfig {
  /** A `postgres:` or `postgresql:` URL. Wrap the password in `Redacted.make`. */
  readonly url: Redacted.Redacted<string>
  /** Maximum pooled connections. Defaults to the driver's 10. */
  readonly maxConnections?: number | undefined
  /** Idle time before a pooled connection is closed. */
  readonly idleTimeout?: Duration.Input | undefined
  /**
   * Cache named prepared statements. Defaults to `true`. Set `false` for a
   * transaction-mode pooler such as PgBouncer.
   */
  readonly prepare?: boolean | undefined
  /** Enable TLS when the URL does not set `sslmode`. */
  readonly ssl?: boolean | undefined
  /**
   * Run collection migrations during app startup. Defaults to `true`. Set
   * `false` when a separate migration job owns the collection DDL.
   */
  readonly migrateAtStartup?: boolean | undefined
}

const validate = (config: PostgresDatabaseConfig) => {
  if (
    config.maxConnections !== undefined &&
    (!Number.isInteger(config.maxConnections) || config.maxConnections <= 0)
  ) {
    throw new PostgresConfigError("maxConnections must be a positive integer")
  }
}

/**
 * PostgreSQL database preset backed by `@effect/sql-pg`.
 *
 * The preset pairs the driver's pooled `SqlClient` with `postgresDialect` and
 * runs a `SELECT 1` readiness probe while the layer is built. An unreachable
 * server, bad credentials, or rejected TLS handshake therefore fail before the
 * app serves requests. The probe uses one pooled connection.
 *
 * `@effect/sql-pg` is imported statically, so the main and Bun entries keep all
 * three presets and a PostgreSQL app never selects the SQLite preset.
 *
 * @example
 * Mira.builder()
 *   .database(PostgresDatabase({
 *     url: Redacted.make("postgres://mira:secret@db.internal:5432/mira"),
 *     maxConnections: 20,
 *     prepare: false
 *   }))
 *
 * @see MiraDatabase - the interface PostgresDatabase implements
 */
export const PostgresDatabase = (config: PostgresDatabaseConfig): MiraDatabase => {
  validate(config)

  const layer: Layer.Layer<DatabaseServices> = Layer.merge(
    PgClient.layer({
      url: config.url,
      maxConnections: config.maxConnections,
      idleTimeout: config.idleTimeout,
      prepare: config.prepare,
      ssl: config.ssl
    }),
    Layer.succeed(Dialect, postgresDialect)
  ).pipe(
    Layer.tap((ctx) => {
      const sql = Context.get(ctx, SqlClient.SqlClient)
      return sql`SELECT 1`
    }),
    Layer.orDie
  )

  return {
    layer,
    ...(config.migrateAtStartup === false ? { migrateAtStartup: false } : {})
  }
}
