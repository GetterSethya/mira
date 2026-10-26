import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient, SqlSchema } from "effect/sql"
import { AppConfig } from "@gettersethya/mira"

const ConfigRowSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.String
})

const ConfigUpdateSchema = Schema.Struct({
  values: Schema.Record(Schema.String, Schema.String)
})

/**
 * Keys the dashboard never exposes: internal state written by other services.
 */
const HIDDEN_KEYS: ReadonlyArray<string> = ["cron_state"]

/**
 * Keys the dashboard shows but refuses to write. `jwt_secret` is readable
 * (the operator may need to copy it) but rotating it is a deliberate
 * out-of-band action — writing it here would silently invalidate every session.
 */
const READ_ONLY_KEYS: ReadonlyArray<string> = ["jwt_secret"]

/**
 * Keys the dashboard may read and write. Everything here is picked up by
 * `AppConfigLive` from the `_config` table, so a change needs a restart.
 */
const EDITABLE_KEYS: ReadonlyArray<string> = [
  "app_name",
  "application_url",
  "port",
  "use_s3",
  "log_retention_days",
  "s3_endpoint",
  "s3_bucket_name",
  "s3_region_name",
  "s3_access_key",
  "s3_secret"
]

/** Keys whose values the UI masks until explicitly revealed. */
const SECRET_KEYS: ReadonlyArray<string> = ["jwt_secret", "s3_access_key", "s3_secret"]

const readRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: ConfigRowSchema,
    execute: () => sql`SELECT key, value FROM ${sql("_config")}`
  })(undefined)
})

/**
 * Persisted `_config` values (minus internal keys) plus the resolved runtime
 * values and the key capability lists the UI needs to render itself.
 */
const snapshot = Effect.gen(function* () {
  const config = yield* AppConfig
  const rows = yield* readRows

  const values: Record<string, string> = {}
  for (const row of rows) {
    if (HIDDEN_KEYS.includes(row.key)) continue
    values[row.key] = row.value
  }

  return {
    appName: config.appName,
    applicationUrl: config.applicationUrl,
    port: config.port,
    values,
    editable: EDITABLE_KEYS,
    readOnly: READ_ONLY_KEYS,
    secret: SECRET_KEYS
  }
})

export const configRoute = snapshot.pipe(Effect.map((data) => HttpServerResponse.jsonUnsafe(data)))

export const configUpdateRoute = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ConfigUpdateSchema)))

  const rejected = Object.keys(body.values).filter((key) => !EDITABLE_KEYS.includes(key))
  if (rejected.length > 0) {
    return HttpServerResponse.jsonUnsafe({ error: "not_editable", keys: rejected }, { status: 400 })
  }

  const sql = yield* SqlClient.SqlClient
  yield* Effect.forEach(
    Object.entries(body.values),
    ([key, value]) =>
      sql`INSERT INTO ${sql("_config")} ${sql.insert({ key, value })}
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`.pipe(Effect.asVoid),
    { discard: true }
  )

  const data = yield* snapshot
  return HttpServerResponse.jsonUnsafe(data)
})
