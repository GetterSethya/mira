import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"

import { CryptoService } from "@/crypto/crypto.js"
import { Dialect } from "@/dialect/dialect.js"
import { withStoreBootstrap } from "@/dialect/store-sql.js"

import { CONFIG_TABLE_DDL } from "./config-sql.js"
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
export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("AppConfig") {}

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
    const dialect = yield* Dialect

    yield* withStoreBootstrap(sql, dialect.store, (tx) =>
      tx.unsafe(CONFIG_TABLE_DDL).pipe(Effect.asVoid)
    )

    const readConfig = () =>
      SqlSchema.findAll({
        Request: Schema.Void,
        Result: ConfigRowSchema,
        execute: () => sql`SELECT key, value FROM ${sql("_config")}`
      })(undefined)

    const insertIfAbsent = (key: string, value: string) =>
      sql`
        INSERT INTO ${sql("_config")} ${sql.insert({ key, value })}
        ON CONFLICT (key) DO NOTHING
      `.pipe(Effect.asVoid)

    yield* insertIfAbsent("app_name", "mira")
    yield* insertIfAbsent("port", "8080")
    yield* insertIfAbsent("use_s3", "false")
    yield* insertIfAbsent("log_retention_days", "30")

    const beforeSecret = new Map((yield* readConfig()).map((row) => [row.key, row.value]))
    if (beforeSecret.get("jwt_secret") === undefined) {
      const cryptoSvc = yield* CryptoService
      const candidate = Buffer.from(yield* cryptoSvc.randomBytes(48)).toString("hex")
      const inserted = yield* sql`
        INSERT INTO ${sql("_config")} ${sql.insert({ key: "jwt_secret", value: candidate })}
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `
      if (inserted.length > 0) {
        yield* Effect.logInfo("jwt_secret generated and persisted to _config table.")
      }
    }

    const afterSecret = new Map((yield* readConfig()).map((row) => [row.key, row.value]))
    const storedPort = Number(afterSecret.get("port") ?? "8080")
    if (afterSecret.get("application_url") === undefined) {
      yield* insertIfAbsent("application_url", `http://localhost:${storedPort}`)
    }

    const stored = new Map((yield* readConfig()).map((row) => [row.key, row.value]))
    const appName = stored.get("app_name") ?? "mira"
    const port = Number(stored.get("port") ?? "8080")
    const applicationUrl = stored.get("application_url") ?? `http://localhost:${port}`
    const jwtSecretStr = stored.get("jwt_secret") ?? ""
    const jwtSecret = Redacted.make(jwtSecretStr)

    const useS3 = (stored.get("use_s3") ?? "false") === "true"

    const s3Config: Option.Option<S3Config> = (() => {
      if (!useS3) return Option.none()
      const endpoint = stored.get("s3_endpoint")
      const bucketName = stored.get("s3_bucket_name")
      const regionName = stored.get("s3_region_name")
      const accessKey = stored.get("s3_access_key")
      const secret = stored.get("s3_secret")
      if (
        endpoint === undefined ||
        bucketName === undefined ||
        regionName === undefined ||
        accessKey === undefined ||
        secret === undefined
      ) {
        return Option.none()
      }
      return Option.some({
        endpoint: Redacted.make(endpoint),
        bucketName,
        regionName,
        accessKey: Redacted.make(accessKey),
        secret: Redacted.make(secret)
      })
    })()
    if (useS3 && Option.isNone(s3Config)) {
      yield* Effect.logWarning(
        "use_s3 is true but the legacy s3_* keys are incomplete; ignoring them. Select storage with .storage(...)."
      )
    }

    const logRetentionDays = Number(stored.get("log_retention_days") ?? "30")

    let boundPort = port
    let boundUrl = applicationUrl
    const updateBoundPort = (next: number) => {
      if (next === boundPort) return
      boundPort = next
      boundUrl = replaceUrlPort(applicationUrl, next)
    }

    return {
      appName,
      get port() {
        return boundPort
      },
      get applicationUrl() {
        return boundUrl
      },
      jwtSecret,
      useS3,
      s3Config,
      logRetentionDays,
      updateBoundPort
    }
  })
)

function replaceUrlPort(url: string, port: number): string {
  if (!URL.canParse(url)) return url
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString().replace(/\/$/, "")
}
