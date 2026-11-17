import { Effect, Layer, Redacted } from "effect"

import type { DatabaseServices, MiraDatabase } from "@/app/types.js"
import { withSqlitePragmas } from "@/databases/pragmas.js"
import type { SqliteSynchronousMode } from "@/databases/pragmas.js"
import { Dialect } from "@/dialect/dialect.js"
import { libsqlConnectionMode, libsqlDialect } from "@/dialect/dialect-libsql.js"

/** An invalid libSQL preset configuration. Thrown before a layer is built. */
export class LibsqlConfigError extends Error {
  readonly _tag = "LibsqlConfigError"

  constructor(message: string) {
    super(message)
    this.name = "LibsqlConfigError"
  }
}

export interface LibsqlDatabaseConfig {
  /**
   * A local `file:` or `:memory:` URL, or a remote `libsql:`, `http:`,
   * `https:`, `ws:`, or `wss:` URL.
   */
  readonly url: string
  /**
   * Auth token for a remote endpoint or the primary behind an embedded replica.
   * Wrap the token in `Redacted.make`.
   */
  readonly authToken?: Redacted.Redacted<string> | undefined
  /**
   * Remote primary to sync with. Only valid on a local `file:` URL. A replica
   * preset sets `migrateAtStartup: false`; migrate the primary and sync before
   * starting the app.
   */
  readonly syncUrl?: string | undefined
  /** Sync interval in seconds. Requires `syncUrl`. */
  readonly syncInterval?: number | undefined
  /**
   * Durability mode for a local file. Remote connections cannot set SQLite
   * pragmas, so this is rejected rather than silently ignored.
   */
  readonly synchronous?: SqliteSynchronousMode | undefined
}

const requireRemoteSyncUrl = (syncUrl: string) => {
  let mode: ReturnType<typeof libsqlConnectionMode>
  try {
    mode = libsqlConnectionMode(syncUrl)
  } catch {
    throw new LibsqlConfigError(
      `syncUrl "${syncUrl}" must use libsql:, http:, https:, ws:, or wss:.`
    )
  }
  if (mode !== "remote") {
    throw new LibsqlConfigError(
      `syncUrl "${syncUrl}" must be a remote libSQL URL, not a local file.`
    )
  }
}

const validate = (config: LibsqlDatabaseConfig, mode: ReturnType<typeof libsqlConnectionMode>) => {
  if (mode === "remote" && config.synchronous !== undefined) {
    throw new LibsqlConfigError(
      "synchronous is a local SQLite pragma and cannot be applied to a remote libSQL URL."
    )
  }
  if (mode === "remote" && config.syncUrl !== undefined) {
    throw new LibsqlConfigError(
      "syncUrl creates an embedded replica and requires a local file: URL."
    )
  }
  if (mode === "local" && config.authToken !== undefined && config.syncUrl === undefined) {
    throw new LibsqlConfigError(
      "authToken is only valid for a remote URL or a local file: URL with syncUrl."
    )
  }
  if (config.url === ":memory:" && config.syncUrl !== undefined) {
    throw new LibsqlConfigError("An in-memory libSQL database cannot be an embedded replica.")
  }
  if (config.syncInterval !== undefined && config.syncUrl === undefined) {
    throw new LibsqlConfigError("syncInterval requires syncUrl.")
  }
  if (config.syncUrl !== undefined) requireRemoteSyncUrl(config.syncUrl)
}

/**
 * libSQL database preset backed by `@effect/sql-libsql`.
 *
 * Local `file:` and `:memory:` URLs use the SQLite dialect, WAL, an explicit
 * busy timeout, disabled SQL foreign-key enforcement, and an optional
 * synchronous mode. Remote URLs skip all writable pragmas and keep only the
 * dialect's telemetry retry and duplicate classification.
 *
 * The driver is imported only when this preset's layer is built, so importing
 * the main `@gettersethya/mira` entry does not load the native libSQL addon.
 *
 * @example
 * Mira.builder()
 *   .database(LibsqlDatabase({ url: "file:./data.db" }))
 *
 * @example
 * Mira.builder()
 *   .database(LibsqlDatabase({
 *     url: "libsql://your-db.turso.io",
 *     authToken: Redacted.make(process.env.TURSO_AUTH_TOKEN!)
 *   }))
 */
export const LibsqlDatabase = (config: LibsqlDatabaseConfig): MiraDatabase => {
  let mode: ReturnType<typeof libsqlConnectionMode>
  try {
    mode = libsqlConnectionMode(config.url)
  } catch (error) {
    throw new LibsqlConfigError(
      error instanceof Error ? error.message : `Unsupported libSQL URL "${config.url}".`
    )
  }
  validate(config, mode)

  const layer = Layer.unwrap(
    Effect.gen(function* () {
      const { LibsqlClient } = yield* Effect.promise(() => import("@effect/sql-libsql"))

      const databaseLayer: Layer.Layer<DatabaseServices> = Layer.mergeAll(
        LibsqlClient.layer({
          url: config.url,
          authToken: config.authToken,
          syncUrl: config.syncUrl,
          syncInterval: config.syncInterval,
          // The local client pools connections. One connection is required so
          // the per-connection pragmas apply to every later statement. The
          // Effect adapter already serializes statements, so no throughput is
          // lost. Embedded replicas and :memory: are single-connection anyway.
          concurrency: 1
        }).pipe(Layer.orDie),
        Layer.succeed(Dialect, libsqlDialect(mode))
      )

      return mode === "local"
        ? withSqlitePragmas(databaseLayer, {
            synchronous: config.synchronous,
            busyTimeout: 5000,
            // libSQL defaults foreign_keys to ON while Mira's other SQLite
            // presets leave it off. The drop/create rebuild must not cascade
            // into user-defined child tables.
            foreignKeys: false
          })
        : databaseLayer
    })
  )

  return {
    layer,
    migrateAtStartup: config.syncUrl === undefined
  }
}

/** Alias for teams that call the database by its hosted name. */
export const TursoDatabase = LibsqlDatabase
