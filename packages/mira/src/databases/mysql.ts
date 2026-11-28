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
  let parsed: URL
  try {
    parsed = new URL(Redacted.value(config.url))
  } catch (cause) {
    throw new MysqlConfigError(`invalid MySQL url: ${String(cause)}`)
  }
  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mysql2:") {
    throw new MysqlConfigError("url must use the mysql: scheme")
  }
  if (parsed.hostname === "") {
    throw new MysqlConfigError("url must include a host")
  }

  let database: string
  let username: string
  let password: string
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, ""))
    username = decodeURIComponent(parsed.username)
    password = decodeURIComponent(parsed.password)
  } catch (cause) {
    throw new MysqlConfigError(`invalid MySQL url encoding: ${String(cause)}`)
  }
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
    username,
    password: Redacted.make(password),
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
        const rows = yield* sql<{
          version: string
          db: string
          collation_present: number
        }>`
          SELECT VERSION() AS version, DATABASE() AS db,
            (SELECT COUNT(*) FROM information_schema.collations
             WHERE collation_name = 'utf8mb4_0900_bin') AS collation_present
        `
        const version = rows[0]?.version ?? ""
        const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
        if (parsed !== null) {
          const major = Number(parsed[1])
          const minor = Number(parsed[2])
          const patch = Number(parsed[3])
          const supported =
            (major === 8 && minor >= 4) ||
            (major === 11 && (minor > 4 || (minor === 4 && patch >= 6)))
          if (!supported) {
            return yield* Effect.die(
              new MysqlConfigError(
                `unsupported MySQL/MariaDB version ${version}; use MySQL 8.4+ or MariaDB 11.4.6+`
              )
            )
          }
        }
        if (Number(rows[0]?.collation_present) === 0) {
          return yield* Effect.die(
            new MysqlConfigError(
              "the server does not provide utf8mb4_0900_bin; MariaDB 11.4.6+ is required"
            )
          )
        }
        yield* Effect.logInfo("mysql.ready", {
          version,
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