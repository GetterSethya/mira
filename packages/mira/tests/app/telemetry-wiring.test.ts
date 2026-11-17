import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BaseCollection, Field } from "@gettersethya/mira-client"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Mira } from "@/app/index.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { NodePlatform } from "@/platforms/node.js"
import { LocalFileStorage } from "@/storage/local-preset.js"
import { makeTelemetryLayerForClient } from "@/telemetry/core.js"
import { makeTelemetryLayer } from "@/telemetry/layer.js"
import {
  type TelemetryStoreShape,
  TelemetryStore
} from "@/telemetry/store.js"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

const readLogs = (store: TelemetryStoreShape) =>
  store.read?.listLogs({ limit: 100, after: null, filter: null, traceId: null }) ??
  Effect.succeed({ items: [], total: 0, nextCursor: null })

const readSpans = (store: TelemetryStoreShape) =>
  store.read?.listSpans({ limit: 100, after: null, filter: null, traceId: null }) ??
  Effect.succeed({ items: [], total: 0, nextCursor: null })

const delay = (millis: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, millis)))

describe("telemetry app wiring", () => {
  it("exposes a dedicated TelemetryStore and keeps the app database separate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-telemetry-wiring-"))
    const appDb = join(dir, "app.db")
    const telemetryDb = join(dir, "telemetry.db")
    const uploads = join(dir, "uploads")

    const app = Mira.builder()
      .platform(NodePlatform)
      .database(SqliteDatabase({ filename: appDb }))
      .storage(LocalFileStorage({ directory: uploads }))
      .collections([Posts])
      .telemetry(
        makeTelemetryLayer({
          storage: {
            mode: "dedicated",
            database: SqliteDatabase({ filename: telemetryDb })
          }
        })
      )
      .build()

    const program = Effect.gen(function* () {
      const store = yield* TelemetryStore
      const appSql = yield* SqlClient.SqlClient

      const appDbs = yield* appSql<{ file: string }>`PRAGMA database_list`
      expect(appDbs[0]?.file).toBe(appDb)

      yield* Effect.logInfo("app-wiring-log")
      yield* Effect.void.pipe(Effect.withSpan("app-wiring-span"))
      yield* delay(100)

      const logs = yield* readLogs(store)
      const spans = yield* readSpans(store)
      expect(logs.items.some((row) => row.message === "app-wiring-log")).toBe(true)
      expect(spans.items.some((row) => row.name === "app-wiring-span")).toBe(true)
    }).pipe(
      Effect.provide(app.buildServiceLayer()),
      Effect.scoped,
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    )

    await Effect.runPromise(program as Effect.Effect<void, never, never>)
  }, 20_000)

  it("skips dedicated telemetry DDL when the database is a replica", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-telemetry-replica-"))
    const appDb = join(dir, "app.db")
    const telemetryDb = join(dir, "telemetry.db")
    const uploads = join(dir, "uploads")
    const preset = SqliteDatabase({ filename: telemetryDb })

    const app = Mira.builder()
      .platform(NodePlatform)
      .database(SqliteDatabase({ filename: appDb }))
      .storage(LocalFileStorage({ directory: uploads }))
      .collections([Posts])
      .telemetry(
        makeTelemetryLayer({
          storage: {
            mode: "dedicated",
            database: {
              layer: preset.layer,
              migrateAtStartup: false
            }
          }
        })
      )
      .build()

    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('logs', 'spans')
      `
      expect(tables).toEqual([])
    }).pipe(
      Effect.provide(app.buildServiceLayer()),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    )

    await Effect.runPromise(program as Effect.Effect<void, never, never>)
  }, 20_000)

  it("keeps a non-SQL TelemetryStore in the built app context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-telemetry-custom-"))
    const appDb = join(dir, "app.db")
    const uploads = join(dir, "uploads")
    const seen: Array<string> = []

    const store: TelemetryStoreShape = {
      appendLogs: (rows) =>
        Effect.sync(() => {
          for (const row of rows) seen.push(row.message)
        }),
      appendSpans: () => Effect.void,
      deleteOlderThan: () => Effect.succeed({ logs: 0, spans: 0 }),
      read: null
    }

    const app = Mira.builder()
      .platform(NodePlatform)
      .database(SqliteDatabase({ filename: appDb }))
      .storage(LocalFileStorage({ directory: uploads }))
      .collections([Posts])
      .telemetry(
        makeTelemetryLayerForClient().pipe(
          Layer.provideMerge(Layer.succeed(TelemetryStore, store))
        )
      )
      .build()

    const program = Effect.gen(function* () {
      expect(yield* TelemetryStore).toBe(store)
      yield* Effect.logInfo("custom-store-log")
      yield* delay(50)
      expect(seen).toContain("custom-store-log")
    }).pipe(
      Effect.provide(app.buildServiceLayer()),
      Effect.scoped,
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    )

    await Effect.runPromise(program as Effect.Effect<void, never, never>)
  }, 20_000)

  it("writes shared telemetry into the application database without changing pragmas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-telemetry-shared-"))
    const appDb = join(dir, "app.db")
    const uploads = join(dir, "uploads")

    const app = Mira.builder()
      .platform(NodePlatform)
      .database(SqliteDatabase({ filename: appDb, synchronous: "FULL" }))
      .storage(LocalFileStorage({ directory: uploads }))
      .collections([Posts])
      .telemetry(makeTelemetryLayer({ storage: { mode: "shared" } }))
      .build()

    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const store = yield* TelemetryStore

      const before = yield* sql<{ synchronous: number }>`PRAGMA synchronous`
      const beforeJournal = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`

      yield* Effect.logInfo("shared-wiring-log")
      yield* delay(100)

      const logs = yield* readLogs(store)
      expect(logs.items.some((row) => row.message === "shared-wiring-log")).toBe(true)

      const after = yield* sql<{ synchronous: number }>`PRAGMA synchronous`
      const afterJournal = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`
      expect(after[0]?.synchronous).toBe(before[0]?.synchronous)
      expect(afterJournal[0]?.journal_mode).toBe(beforeJournal[0]?.journal_mode)
    }).pipe(
      Effect.provide(app.buildServiceLayer()),
      Effect.scoped,
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true })))
    )

    await Effect.runPromise(program as Effect.Effect<void, never, never>)
  }, 20_000)
})
