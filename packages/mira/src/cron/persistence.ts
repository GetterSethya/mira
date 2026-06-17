import { SqlClient, SqlSchema } from "@effect/sql"
import { Effect, HashMap, Schema } from "effect"
import type { CronState } from "./types.js"

export const CRON_STATE_CONFIG_KEY = "cron_state"

const PersistedCronEntrySchema = Schema.Struct({
  lastRunAt: Schema.NullOr(Schema.String),
  lastStatus: Schema.NullOr(Schema.Literal("success", "error")),
  lastDurationMs: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String)
})

const PersistedCronStateSchema = Schema.Record({ key: Schema.String, value: PersistedCronEntrySchema })

export type PersistedCronState = typeof PersistedCronStateSchema.Type

const ConfigRowSchema = Schema.Struct({ value: Schema.String })

export function loadPersistedCronState(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    // DDL — sql.unsafe is fine for CREATE TABLE
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)

    const rows = yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: ConfigRowSchema,
      execute: (key) => sql`SELECT value FROM ${sql("_config")} WHERE key = ${key}`
    })(CRON_STATE_CONFIG_KEY)

    const row = rows[0]
    if (row === undefined) return {} as PersistedCronState

    return yield* Schema.decode(Schema.parseJson(PersistedCronStateSchema))(row.value).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning(`[cron] failed to decode persisted cron_state, starting fresh: ${String(e)}`).pipe(
          Effect.as({} as PersistedCronState)
        )
      )
    )
  }).pipe(
    Effect.withSpan("cron.persistence.load", {
      kind: "client",
      attributes: { table: "_config", "cron.config_key": CRON_STATE_CONFIG_KEY }
    })
  )
}

export function savePersistedCronState(sql: SqlClient.SqlClient, states: HashMap.HashMap<string, CronState>) {
  return Effect.gen(function* () {
    const blob: { [key: string]: typeof PersistedCronEntrySchema.Type } = {}
    for (const state of HashMap.values(states)) {
      blob[state.name] = {
        lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
        lastStatus: state.lastStatus ?? null,
        lastDurationMs: state.lastDurationMs ?? null,
        lastError: state.lastError !== undefined ? String(state.lastError) : null
      }
    }
    const json = yield* Schema.encode(Schema.parseJson(PersistedCronStateSchema))(blob)
    yield* sql`INSERT OR REPLACE INTO ${sql("_config")} ${sql.insert({ key: CRON_STATE_CONFIG_KEY, value: json })}`
  }).pipe(
    Effect.withSpan("cron.persistence.save", {
      kind: "client",
      attributes: { table: "_config", "cron.config_key": CRON_STATE_CONFIG_KEY }
    }),
    Effect.catchAllCause((cause) => Effect.logWarning(`[cron] failed to persist cron_state: ${String(cause)}`))
  )
}
