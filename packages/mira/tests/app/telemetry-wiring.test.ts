import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-node"
import { BaseCollection, Field } from "@gettersethya/mira-client"
import { describe, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Mira } from "@/app/index.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { makeSqliteTelemetryLayer } from "@/telemetry/sqlite-logger.js"
import { TelemetrySqlClient } from "@/telemetry/telemetry-sql-client.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

describe("telemetry app wiring", () => {
  it("exposes TelemetrySqlClient from the app layer and keeps it separate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-telemetry-wiring-"))
    const appDb = join(dir, "app.db")
    const telemetryDb = join(dir, "telemetry.db")
    const uploads = join(dir, "uploads")

    const program = Effect.gen(function* () {
      const app = Mira.builder()
        .platform(NodePlatform)
        .database(SqliteDatabase({ filename: appDb }))
        .storage(LocalFileStorage({ directory: uploads }))
        .collections([Posts])
        .telemetry(
          makeSqliteTelemetryLayer({
            sqlLayer: SqliteClient.layer({ filename: telemetryDb })
          })
        )
        .build()

      const context = yield* Layer.build(app.buildServiceLayer())
      const telemetry = Context.get(context, TelemetrySqlClient)
      const appSql = Context.get(context, SqlClient.SqlClient)

      const telemetryDbs = yield* telemetry<{ file: string }>`PRAGMA database_list`
      const appDbs = yield* appSql<{ file: string }>`PRAGMA database_list`
      expect(telemetryDbs[0]?.file).toBe(telemetryDb)
      expect(appDbs[0]?.file).toBe(appDb)

      yield* Effect.logInfo("app-wiring-log")
      yield* Effect.void.pipe(Effect.withSpan("app-wiring-span"))
      yield* Effect.sleep("100 millis")

      const logs = yield* telemetry<{ count: number }>`SELECT COUNT(*) AS count FROM logs`
      const spans = yield* telemetry<{ count: number }>`SELECT COUNT(*) AS count FROM spans`
      expect(Number(logs[0]?.count ?? 0)).toBeGreaterThan(0)
      expect(Number(spans[0]?.count ?? 0)).toBeGreaterThan(0)
    }).pipe(
      Effect.scoped,
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    )

    // The service layer is self-contained at runtime. TypeScript widens the
    // inferred requirement through the builder's plugin/cron generics to `any`.
    await Effect.runPromise(program as Effect.Effect<void, never, never>)
  }, 20_000)
})
