import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { AppConfig, AppConfigLive } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"

const db = SqliteClient.layer({ filename: ":memory:" })
const freshLayer = AppConfigLive.pipe(Layer.provide(db), Layer.provide(NodeCryptoLayer))

function preSeeded(rows: Record<string, string>) {
  return Layer.unwrapEffect(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(
        `CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
      )
      for (const [key, value] of Object.entries(rows)) {
        yield* sql`INSERT INTO ${sql("_config")} ${sql.insert({ key, value })}`
      }
      return AppConfigLive
    })
  ).pipe(Layer.provide(NodeCryptoLayer))
}

describe("AppConfig", () => {
  it.effect("first boot seeds base defaults", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(config.appName).toBe("mira")
      expect(config.port).toBe(8080)
      expect(config.applicationUrl).toBe("http://localhost:8080")
      expect(config.useS3).toBe(false)
      expect(Option.isNone(config.s3Config)).toBe(true)
    }).pipe(Effect.provide(freshLayer))
  )

  it.effect("jwt_secret is a 96-char hex string on first boot", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(Redacted.value(config.jwtSecret)).toHaveLength(96)
    }).pipe(Effect.provide(freshLayer))
  )

  it.effect("jwt_secret is persisted to the _config table", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT value FROM ${sql("_config")} WHERE key = 'jwt_secret'`
      expect(rows).toHaveLength(1)
      expect((rows[0] as { value: string })["value"]).toBe(Redacted.value(config.jwtSecret))
    }).pipe(Effect.provide(AppConfigLive.pipe(Layer.provideMerge(db), Layer.provideMerge(NodeCryptoLayer))))
  )

  it.effect("application_url derives from custom port", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(config.applicationUrl).toBe("http://localhost:9000")
    }).pipe(
      Effect.provide(preSeeded({ port: "9000" }).pipe(Layer.provide(db)))
    )
  )

  it.effect("explicit application_url overrides port-derived default", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(config.applicationUrl).toBe("https://example.com")
    }).pipe(
      Effect.provide(
        preSeeded({ port: "9000", application_url: "https://example.com" }).pipe(Layer.provide(db))
      )
    )
  )

  it.effect("custom app_name is respected", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(config.appName).toBe("myapp")
    }).pipe(
      Effect.provide(preSeeded({ app_name: "myapp" }).pipe(Layer.provide(db)))
    )
  )

  it.effect("S3 disabled by default", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(Option.isNone(config.s3Config)).toBe(true)
    }).pipe(Effect.provide(freshLayer))
  )

  it.effect("S3 enabled with all keys returns Option.some", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      expect(Option.isSome(config.s3Config)).toBe(true)
      if (Option.isSome(config.s3Config)) {
        const s3 = config.s3Config.value
        expect(Redacted.value(s3.endpoint)).toBe("https://s3.example.com")
        expect(s3.bucketName).toBe("bucket")
        expect(s3.regionName).toBe("us-east-1")
        expect(Redacted.value(s3.accessKey)).toBe("key")
        expect(Redacted.value(s3.secret)).toBe("secret")
      }
    }).pipe(
      Effect.provide(
        preSeeded({
          use_s3: "true",
          s3_endpoint: "https://s3.example.com",
          s3_bucket_name: "bucket",
          s3_region_name: "us-east-1",
          s3_access_key: "key",
          s3_secret: "secret",
        }).pipe(Layer.provide(db))
      )
    )
  )

  it.effect("S3 enabled with missing keys causes defect", () =>
    Effect.gen(function* () {
      const seededLayer = preSeeded({ use_s3: "true" }).pipe(Layer.provide(db))
      const exit = yield* Effect.exit(Effect.provide(AppConfig, seededLayer))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.isDie(exit.cause)).toBe(true)
      }
    })
  )
})
