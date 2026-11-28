import { Effect, HashMap, Schema } from "effect"
import { SqlSchema } from "effect/sql"
import type { SqlClient } from "effect/sql"

import type { DialectType } from "@/dialect/dialect.js"

import type { CronState } from "./types.js"

export const CRON_STATE_CONFIG_KEY = "cron_state"

const PersistedCronEntrySchema = Schema.Struct({
  lastRunAt: Schema.NullOr(Schema.String),
  lastStatus: Schema.NullOr(Schema.Literals(["success", "error"])),
  lastDurationMs: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String)
})

const PersistedCronStateSchema = Schema.Record(Schema.String, PersistedCronEntrySchema)

export type PersistedCronState = typeof PersistedCronStateSchema.Type

const ConfigRowSchema = Schema.Struct({ value: Schema.String })

export function loadPersistedCronState(sql: SqlClient.SqlClient, _dialect: DialectType) {
  return Effect.gen(function* () {
    const emptyState: PersistedCronState = {}

    const rows = yield* SqlSchema.findAll({
      Request: Schema.String,
      Result: ConfigRowSchema,
      execute: (key) =>
        sql`SELECT ${sql("value")} FROM ${sql("_config")} WHERE ${sql("key")} = ${key}`
    })(CRON_STATE_CONFIG_KEY)

    const row = rows[0]
    if (row === undefined) return emptyState

    return yield* Schema.decodeEffect(Schema.fromJsonString(PersistedCronStateSchema))(row.value).pipe(
      Effect.catch((e) =>
        Effect.logWarning(`[cron] failed to decode persisted cron_state, starting fresh: ${String(e)}`).pipe(
          Effect.as(emptyState)
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

export function savePersistedCronState(
  sql: SqlClient.SqlClient,
  states: HashMap.HashMap<string, CronState>,
  dialect: DialectType
) {
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
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(PersistedCronStateSchema))(blob)
    yield* sql`
      INSERT INTO ${sql("_config")} ${sql.insert({ key: CRON_STATE_CONFIG_KEY, value: json })}
      ${sql.literal(
        dialect.store.upsertClause(["key"], [{ column: "value", kind: "excluded" }])
      )}
    `
  }).pipe(
    Effect.withSpan("cron.persistence.save", {
      kind: "client",
      attributes: { table: "_config", "cron.config_key": CRON_STATE_CONFIG_KEY }
    }),
    Effect.catchCause((cause) => Effect.logWarning(`[cron] failed to persist cron_state: ${String(cause)}`))
  )
}


