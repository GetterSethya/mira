import { Layer } from "effect"
import { Effect, Schedule } from "effect"
import type { SqlClient } from "effect/sql"

import type { DatabaseServices } from "@/app/types.js"
import { AppConfig } from "@/config/index.js"
import type { CronDef } from "@/cron/types.js"
import type { CryptoService } from "@/crypto/crypto.js"
import type { Dialect } from "@/dialect/dialect.js"

import type { TelemetryCoreConfig } from "./core.js"
import { makeTelemetryLayerForClient } from "./core.js"
import { makeSqlTelemetryStoreLayer } from "./sql-store.js"
import { TelemetryStore } from "./store.js"
import type { TelemetryStoreError } from "./store.js"

/** A database preset that supplies both the SQL client and its dialect. */
export interface TelemetryDatabase {
  readonly layer: Layer.Layer<SqlClient.SqlClient | Dialect, never, never>
  /**
   * Whether the store should create its telemetry tables. Defaults to true.
   * A libSQL embedded-replica preset sets this to false because the tables must
   * be created on the primary and synced, not written through the replica.
   */
  readonly migrateAtStartup?: boolean
}

export type TelemetryStorageConfig =
  | {
      readonly mode: "dedicated"
      readonly database: TelemetryDatabase
      /**
       * Defaults to true. When false, telemetry does not run dialect setup or
       * cleanup, so a preset's explicit synchronous mode wins.
       */
      readonly manageConnection?: boolean
    }
  | {
      readonly mode: "shared"
      /**
       * Whether the shared store should create `_telemetry_*` tables. Defaults
       * to true. Set false when the application database is an embedded
       * replica; migrate the tables on the primary and sync instead.
       */
      readonly migrate?: boolean
    }

export interface TelemetryLoggerConfig extends TelemetryCoreConfig {
  readonly storage: TelemetryStorageConfig
}

/**
 * Composes the SQL store and the SQL-free core.
 *
 * `Layer.provideMerge` is required: `Layer.provide` would satisfy the core but
 * drop `TelemetryStore` from the output, so the app context, routes, and
 * cleanup cron would not see the store.
 */
export function makeTelemetryLayer(
  config: TelemetryLoggerConfig
): Layer.Layer<TelemetryStore, never, CryptoService | DatabaseServices> {
  const core = makeTelemetryLayerForClient(config)

  if (config.storage.mode === "dedicated") {
    const store = makeSqlTelemetryStoreLayer({
      dedicated: true,
      manageConnection: config.storage.manageConnection !== false,
      migrate: config.storage.database.migrateAtStartup !== false
    })
    return core.pipe(Layer.provideMerge(store.pipe(Layer.provide(config.storage.database.layer))), Layer.orDie)
  }

  const store = makeSqlTelemetryStoreLayer({
    dedicated: false,
    migrate: config.storage.migrate !== false
  })
  return core.pipe(Layer.provideMerge(store), Layer.orDie)
}

/**
 * Daily retention job. It contains no SQL, no PRAGMA, and no driver reference:
 * the store owns both. A failed purge is logged with its cause and the run is
 * marked failed; the scheduler still schedules the next run.
 */
export const logCleanupCronDef: CronDef<TelemetryStore | AppConfig, TelemetryStoreError> = {
  name: "mira:log-cleanup",
  description: "Delete logs and spans older than logRetentionDays days",
  schedule: Schedule.cron("0 0 * * *"),
  handler: () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const config = yield* AppConfig
      const cutoff = new Date(Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000).toISOString()
      const deleted = yield* store
        .deleteOlderThan(cutoff)
        .pipe(
          Effect.tapError((error) =>
            Effect.logError(`[mira:log-cleanup] delete failed: ${error._tag} cause=${String(error.cause)}`)
          )
        )
      yield* Effect.logInfo(
        `[mira:log-cleanup] deleted ${deleted.logs} logs and ${deleted.spans} spans older than ${cutoff}`
      )
    })
}
