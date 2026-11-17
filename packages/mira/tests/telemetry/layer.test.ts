import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { expect, vi } from "vitest"

import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/index.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { makeTelemetryLayerForClient } from "@/telemetry/core.js"
import { logCleanupCronDef } from "@/telemetry/layer.js"
import { makeSqlTelemetryStoreLayer } from "@/telemetry/sql-store.js"
import {
  type TelemetryLogEntry,
  type TelemetryStoreShape,
  TelemetryStore
} from "@/telemetry/store.js"

function makeLayer(logConsole = false, options: { flushBatchSize?: number } = {}) {
  const database = SqliteDatabase({ filename: ":memory:" })
  const store = makeSqlTelemetryStoreLayer({ dedicated: true }).pipe(
    Layer.provide(database.layer)
  )

  const config =
    options.flushBatchSize === undefined
      ? { logConsole }
      : { logConsole, flushBatchSize: options.flushBatchSize }

  return makeTelemetryLayerForClient(config).pipe(
    Layer.provideMerge(store),
    Layer.provideMerge(database.layer),
    Layer.provide(NodeCryptoLayer)
  )
}

async function drainMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

const queryLogs = <A extends object>(statement: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.unsafe<A>(statement)
  })

const readLogs = (store: TelemetryStoreShape) =>
  store.read?.listLogs({ limit: 100, after: null, filter: null, traceId: null }) ??
  Effect.succeed({ items: [], total: 0, nextCursor: null })

describe("makeTelemetryLayerForClient", () => {
  it.effect("writes log rows to SQLite", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("hello sqlite")
      yield* Effect.promise(drainMicrotasks)

      const rows = yield* queryLogs<{ level: string; message: string }>(
        "SELECT level, message FROM logs"
      )
      const row = rows.find((candidate) => candidate.message === "hello sqlite")
      expect(row?.level).toBe("INFO")
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("writes multiple log levels", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("info msg")
      yield* Effect.logWarning("warn msg")
      yield* Effect.logError("error msg")
      yield* Effect.promise(drainMicrotasks)

      const rows = yield* queryLogs<{ level: string }>("SELECT level FROM logs ORDER BY seqId")
      const levels = rows.map((row) => row.level)
      expect(levels).toContain("INFO")
      expect(levels).toContain("WARN")
      expect(levels).toContain("ERROR")
    }).pipe(Effect.provide(makeLayer()))
  )

  it("also logs to console when logConsole is true", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("console check")
        yield* Effect.promise(drainMicrotasks)
      }).pipe(Effect.provide(makeLayer(true)))
    )

    const calls = spy.mock.calls.slice()
    spy.mockRestore()
    const call = calls.find((candidate) => {
      try {
        return JSON.parse(candidate[0] as string).message === "console check"
      } catch {
        return false
      }
    })
    expect(call).toBeDefined()
  })

  it.effect("writes span rows and JSON attributes", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(
        Effect.withSpan("attr-span", { attributes: { "cache.hit": true, count: 42 } })
      )
      yield* Effect.promise(drainMicrotasks)

      const rows = yield* queryLogs<{ name: string; status: string; attributes: string }>(
        "SELECT name, status, attributes FROM spans"
      )
      const row = rows.find((candidate) => candidate.name === "attr-span")
      expect(row?.status).toBe("ok")
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Record(
            Schema.String,
            Schema.Union([Schema.String, Schema.Number, Schema.Boolean])
          )
        )
      )(row?.attributes ?? "{}").pipe(Effect.orDie)
      expect(decoded["cache.hit"]).toBe(true)
      expect(decoded["count"]).toBe(42)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("log rows carry traceId and spanId inside a span", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("inside-span-log").pipe(Effect.withSpan("ctx-span"))
      yield* Effect.promise(drainMicrotasks)

      const rows = yield* queryLogs<{ traceId: string | null; spanId: string | null }>(
        "SELECT traceId, spanId FROM logs WHERE message = 'inside-span-log'"
      )
      expect(rows[0]?.traceId).not.toBeNull()
      expect(rows[0]?.spanId).not.toBeNull()
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("creates the dedicated metadata tables", () =>
    Effect.gen(function* () {
      const names = yield* queryLogs<{ name: string }>(
        "SELECT name FROM _collections ORDER BY name"
      )
      expect(names.map((row) => row.name)).toContain("logs")
      expect(names.map((row) => row.name)).toContain("spans")
    }).pipe(Effect.provide(makeLayer()))
  )

  it("drains queued logs when the scope closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-telemetry-drain-"))
    const filename = join(dir, "telemetry.db")
    const database = SqliteDatabase({ filename })
    const store = makeSqlTelemetryStoreLayer({ dedicated: true }).pipe(
      Layer.provide(database.layer)
    )
    const layer = makeTelemetryLayerForClient().pipe(
      Layer.provideMerge(store),
      Layer.provide(NodeCryptoLayer)
    )

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from({ length: 500 }),
            (_, index) => Effect.logInfo(`drain-${index}`),
            { discard: true }
          )
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      const count = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM logs`
          return Number(rows[0]?.count ?? 0)
        }).pipe(Effect.provide(database.layer), Effect.scoped)
      )

      expect(count).toBe(500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it.effect("batches rows with flushBatchSize", () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from({ length: 25 }),
        (_, index) => Effect.logInfo(`batched-${index}`),
        { discard: true }
      )
      yield* Effect.promise(drainMicrotasks)

      const rows = yield* queryLogs<{ count: number }>(
        "SELECT COUNT(*) AS count FROM logs WHERE message LIKE 'batched-%'"
      )
      expect(Number(rows[0]?.count ?? 0)).toBe(25)
    }).pipe(Effect.provide(makeLayer(false, { flushBatchSize: 10 })))
  )
})

describe("logCleanupCronDef", () => {
  const makeCleanupLayer = () =>
    Layer.merge(
      makeLayer(),
      Layer.succeed(
        AppConfig,
        AppConfig.of({
          appName: "test",
          port: 8080,
          applicationUrl: "http://localhost:8080",
          jwtSecret: Redacted.make("test"),
          useS3: false,
          s3Config: Option.none(),
          logRetentionDays: 7
        })
      )
    )

  const entry = (id: string, created: string): TelemetryLogEntry => ({
    id,
    level: "INFO",
    message: id,
    created,
    updated: created,
    traceId: null,
    spanId: null
  })

  it("has the correct name and description", () => {
    expect(logCleanupCronDef.name).toBe("mira:log-cleanup")
    expect(logCleanupCronDef.description).toBe(
      "Delete logs and spans older than logRetentionDays days"
    )
  })

  it.effect("deletes old rows through the store and logs actual counts", () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()

      yield* store.appendLogs([entry("old-log", old), entry("new-log", recent)])
      yield* logCleanupCronDef.handler()

      const page = yield* readLogs(store)
      expect(page.items.map((row) => row.id)).toEqual(["new-log"])
    }).pipe(Effect.provide(makeCleanupLayer()))
  )
})
