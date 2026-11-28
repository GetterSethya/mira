import { MysqlClient } from "@effect/sql-mysql2"
import { Context, Duration, Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"

import type { DatabaseServices, MiraDatabase } from "@/app/types.js"
import { Dialect } from "@/dialect/dialect.js"
import { mysqlDialect } from "@/dialect/dialect-mysql.js"

/** An invalid MySQL preset configuration. */
export class MysqlConfigError extends Error {
  readonly _tag = "MysqlConfigError"

  constructor(message: string) {
    super(message)
    this.name = "MysqlConfigError"
  }
}

export type MysqlSslOptions = {
  readonly ca?: string
  readonly cert?: string
  readonly key?: string
  readonly rejectUnauthorized?: boolean
}

export interface MysqlDatabaseConfig {
  /** A `mysql:` URL such as `mysql://user:password@host:3306/database`. */
  readonly url: Redacted.Redacted<string>
  /** Maximum pooled connections. Defaults to the driver's 10. */
  readonly maxConnections?: number | undefined
  /** Pool idle time, mapped to the driver's connection TTL. */
  readonly connectionTTL?: Duration.Input | undefined
  /** TLS options. `true` enables TLS with driver defaults. */
  readonly ssl?: boolean | MysqlSslOptions | undefined
  /** Connection timeout, in milliseconds after decoding. */
  readonly connectTimeout?: Duration.Input | undefined
  /** Disable named prepared statements for a proxy that rejects them. */
  readonly disablePreparedStatements?: boolean | undefined
  /**
   * Run collection migrations during app startup. Defaults to `true`.
   * Internal stores still run their idempotent bootstrap DDL.
   */
  readonly migrateAtStartup?: boolean | undefined
}

/**
 * Parses the preset URL into the driver's non-URL connection shape.
 *
 * The URL branch of `MysqlClient.layer` ignores `poolConfig`, so the preset
 * always builds the non-URL options. Query parameters are not forwarded;
 * `ssl` and `connectTimeout` are explicit config fields.
 */
export const mysqlPoolOptions = (config: MysqlDatabaseConfig) => {
  const parsed = new URL(Redacted.value(config.url))
  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mysql2:") {
    throw new MysqlConfigError("url must use the mysql: scheme")
  }
  if (parsed.hostname === "") {
    throw new MysqlConfigError("url must include a host")
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""))
  if (database === "") {
    throw new MysqlConfigError("url must include a database name")
  }
  if (
    config.maxConnections !== undefined &&
    (!Number.isInteger(config.maxConnections) || config.maxConnections <= 0)
  ) {
    throw new MysqlConfigError("maxConnections must be a positive integer")
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "")
  const port = parsed.port === "" ? 3306 : Number(parsed.port)
  const poolConfig = {
    ...(config.ssl === undefined || config.ssl === false
      ? {}
      : { ssl: config.ssl === true ? {} : config.ssl }),
    ...(config.connectTimeout === undefined
      ? {}
      : { connectTimeout: Duration.toMillis(config.connectTimeout) })
  }

  return {
    host,
    port,
    database,
    username: decodeURIComponent(parsed.username),
    password: Redacted.make(decodeURIComponent(parsed.password)),
    ...(config.maxConnections === undefined
      ? {}
      : { maxConnections: config.maxConnections }),
    ...(config.connectionTTL === undefined
      ? {}
      : { connectionTTL: config.connectionTTL }),
    ...(config.disablePreparedStatements === undefined
      ? {}
      : { disablePreparedStatements: config.disablePreparedStatements }),
    ...(Object.keys(poolConfig).length === 0 ? {} : { poolConfig })
  }
}

/**
 * MySQL/MariaDB database preset backed by `@effect/sql-mysql2`.
 *
 * The preset parses the URL into the driver's non-URL options so `ssl`,
 * `connectTimeout`, and `disablePreparedStatements` reach the pool. It pairs
 * the client with `mysqlDialect` and runs a readiness probe before serving.
 *
 * @example
 * Mira.builder()
 *   .database(MysqlDatabase({
 *     url: Redacted.make("mysql://mira:secret@db.internal:3306/mira"),
 *     maxConnections: 20,
 *     ssl: true
 *   }))
 */
export const MysqlDatabase = (config: MysqlDatabaseConfig): MiraDatabase => {
  const options = mysqlPoolOptions(config)

  const layer: Layer.Layer<DatabaseServices> = Layer.merge(
    MysqlClient.layer(options),
    Layer.succeed(Dialect, mysqlDialect)
  ).pipe(
    Layer.tap((ctx) => {
      const sql = Context.get(ctx, SqlClient.SqlClient)
      return Effect.gen(function* () {
        const rows = yield* sql<{ version: string; db: string }>`
          SELECT VERSION() AS version, DATABASE() AS db
        `
        yield* Effect.logInfo("mysql.ready", {
          version: rows[0]?.version,
          database: rows[0]?.db,
          maxConnections: config.maxConnections ?? 10
        })
      })
    }),
    Layer.orDie
  )

  return {
    layer,
    ...(config.migrateAtStartup === false ? { migrateAtStartup: false } : {})
  }
}