import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { AppConfig, AppConfigLive } from "@/config/index.js"
import { CONFIG_TABLE_DDL } from "@/config/config-sql.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

const db = SqliteClient.layer({ filename: ":memory:" })
const dialectLayer = Layer.succeed(Dialect, sqliteDialect)
const freshLayer = AppConfigLive.pipe(
  Layer.provide(Layer.mergeAll(db, dialectLayer)),
  Layer.provide(NodeCryptoLayer)
)

function preSeeded(rows: Record<string, string>) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql.unsafe(CONFIG_TABLE_DDL)
      for (const [key, value] of Object.entries(rows)) {
        yield* sql`INSERT INTO ${sql("_config")} ${sql.insert({ key, value })}`
      }
      return AppConfigLive
    })
  ).pipe(Layer.provide(Layer.mergeAll(db, dialectLayer)), Layer.provide(NodeCryptoLayer))
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
      const rows = yield* sql<{ value: string }>`SELECT value FROM ${sql("_config")} WHERE key = 'jwt_secret'`
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe(Redacted.value(config.jwtSecret))
    }).pipe(
      Effect.provide(
        AppConfigLive.pipe(
          Layer.provideMerge(db),
          Layer.provideMerge(dialectLayer),
          Layer.provideMerge(NodeCryptoLayer)
        )
      )
    )
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

  it.effect("updateBoundPort rebinds port and applicationUrl", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      config.updateBoundPort?.(9001)
      expect(config.port).toBe(9001)
      expect(config.applicationUrl).toBe("http://localhost:9001")
    }).pipe(Effect.provide(freshLayer))
  )

  it.effect("updateBoundPort preserves an explicit application_url host", () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      config.updateBoundPort?.(9001)
      expect(config.applicationUrl).toBe("https://example.com:9001")
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

  it.effect("S3 enabled with missing keys is non-fatal", () =>
    Effect.gen(function* () {
      const seededLayer = preSeeded({ use_s3: "true" }).pipe(Layer.provide(db))
      const config = yield* Effect.provide(AppConfig, seededLayer)
      expect(Option.isNone(config.s3Config)).toBe(true)
    })
  )
})
