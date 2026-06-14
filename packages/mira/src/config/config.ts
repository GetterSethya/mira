import { SqlClient, SqlSchema } from "@effect/sql"
import { CryptoService } from "@/crypto/index.js"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import type { AppConfigShape, S3Config } from "./types.js"

const ConfigRowSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.String
})

/**
 * Application configuration tag, backed by the `_config` table in the database.
 *
 * On first boot, seeds default values (including an auto-generated `jwt_secret`)
 * into the `_config` table. Runtime reads go through the database — no env vars
 * or config files are needed for basic operation.
 *
 * Provides access to:
 * - `appName`, `port`, `applicationUrl` — basic server configuration
 * - `jwtSecret` — Redacted JWT signing secret (auto-generated)
 * - `useS3`, `s3Config` — optional S3 storage configuration
 *
 * @example
 * import { AppConfig } from "@gettersethya/mira"
 *
 * Effect.gen(function* () {
 *   const cfg = yield* AppConfig
 *   console.log(cfg.appName, cfg.port)
 *   const secret = cfg.jwtSecret  // Redacted<string>
 * })
 *
 * @see AppConfigLive — the live layer implementation
 * @see AppConfigShape — the full config shape
 */
export class AppConfig extends Context.Tag("AppConfig")<AppConfig, AppConfigShape>() {}

/**
 * Live layer for `AppConfig`.
 * Seeds the `_config` table on first boot with sensible defaults
 * (including auto-generating `jwt_secret` via CryptoService).
 *
 * @example
 * Layer.provideMerge(AppConfigLive)
 *
 * @see AppConfig — the service tag
 */
export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    // DDL — sql.unsafe is fine for CREATE TABLE
    yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)

    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: ConfigRowSchema,
      execute: () => sql`SELECT key, value FROM ${sql("_config")}`
    })(undefined)

    const stored = new Map(rows.map((r) => [r.key, r.value]))

    const seed = (key: string, defaultValue: string) =>
      Effect.gen(function* () {
        const existing = stored.get(key)
        if (existing !== undefined) return existing
        yield* sql`INSERT INTO ${sql("_config")} ${sql.insert({ key, value: defaultValue })}`
        return defaultValue
      })

    const require = (key: string) =>
      Effect.fromNullable(stored.get(key)).pipe(
        Effect.mapError(() => new Error(`_config key "${key}" is required when use_s3=true`)),
        Effect.orDie
      )

    const appName = yield* seed("app_name", "mira")
    const port = Number(yield* seed("port", "8080"))
    const applicationUrl = yield* seed("application_url", `http://localhost:${port}`)

    // Generated once on first boot, persisted so tokens survive restarts
    const existingSecret = stored.get("jwt_secret")
    const jwtSecretStr =
      existingSecret !== undefined
        ? existingSecret
        : yield* Effect.gen(function* () {
            const cryptoSvc = yield* CryptoService
            const generated = Buffer.from(yield* cryptoSvc.randomBytes(48)).toString("hex")
            yield* sql`INSERT INTO ${sql("_config")} ${sql.insert({ key: "jwt_secret", value: generated })}`
            yield* Effect.logInfo("jwt_secret generated and persisted to _config table.")
            return generated
          })
    const jwtSecret = Redacted.make(jwtSecretStr)

    const useS3 = (yield* seed("use_s3", "false")) === "true"

    const s3Config: Option.Option<S3Config> = useS3
      ? Option.some({
          endpoint: Redacted.make(yield* require("s3_endpoint")),
          bucketName: yield* require("s3_bucket_name"),
          regionName: yield* require("s3_region_name"),
          accessKey: Redacted.make(yield* require("s3_access_key")),
          secret: Redacted.make(yield* require("s3_secret"))
        })
      : Option.none()

    const logRetentionDays = Number(yield* seed("log_retention_days", "30"))

    return { appName, port, applicationUrl, jwtSecret, useS3, s3Config, logRetentionDays }
  })
)
