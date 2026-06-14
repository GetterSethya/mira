import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { describe, it } from "@effect/vitest"
import { expect, vi } from "vitest"
import { makeSqliteTelemetryLayerForClient, logCleanupCronDef } from "@/telemetry/sqlite-logger.js"
import { NodeCryptoLayer } from "@/crypto/index.js"
import { AppConfig } from "@/config/index.js"
import { TelemetrySqlClient } from "@/telemetry/telemetry-sql-client.js"

function makeLayer(logConsole = false) {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
  return makeSqliteTelemetryLayerForClient({ logConsole }).pipe(
    Layer.provide(NodeCryptoLayer),
    Layer.provideMerge(sqliteLayer)
  )
}

async function drainMicrotasks() {
  // Logger uses fire-and-forget Effect.runPromise; flush so the INSERT commits.
  // Span consumer is an Effect fiber; the timeout gives the scheduler time to process.
  await new Promise((r) => setTimeout(r, 20))
}

describe("makeSqliteTelemetryLayerForClient", () => {
  it.effect("writes log rows to SQLite", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("hello sqlite")
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ level: string; message: string }>`SELECT level, message FROM logs`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows.find((r) => r.message === "hello sqlite")
      expect(row).toBeDefined()
      expect(row?.level).toBe("INFO")
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("writes multiple log levels", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("info msg")
      yield* Effect.logWarning("warn msg")
      yield* Effect.logError("error msg")
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ level: string; message: string }>`SELECT level, message FROM logs ORDER BY seqId`

      const levels = rows.map((r) => r.level)
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

    const call = calls.find((c) => {
      try { return JSON.parse(c[0] as string).message === "console check" } catch { return false }
    })
    expect(call).toBeDefined()
  })

  it("does NOT log to console when logConsole is false", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("silent check")
      }).pipe(Effect.provide(makeLayer(false)))
    )

    const calls = spy.mock.calls.slice()
    spy.mockRestore()

    const sqliteCall = calls.find((c) => {
      try { return JSON.parse(c[0] as string).message === "silent check" } catch { return false }
    })
    expect(sqliteCall).toBeUndefined()
  })

  it.effect("created is a valid ISO string", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("ts-test")
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ created: string }>`SELECT created FROM logs WHERE message = 'ts-test'`

      expect(rows.length).toBeGreaterThan(0)
      const firstRow = rows[0]
      expect(firstRow).toBeDefined()
      if (firstRow === undefined) return
      expect(new Date(firstRow.created).getTime()).not.toBeNaN()
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("writes span rows to SQLite when a span completes", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("test-span"))
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ name: string; status: string }>`SELECT name, status FROM spans`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows.find((r) => r.name === "test-span")
      expect(row).toBeDefined()
      expect(row?.status).toBe("ok")
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("failed span writes error status to spans table", () =>
    Effect.gen(function* () {
      yield* Effect.fail("boom").pipe(Effect.withSpan("failing-span"), Effect.ignore)
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ status: string; error: string | null }>`SELECT status, error FROM spans WHERE name = 'failing-span'`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows[0]
      expect(row).toBeDefined()
      expect(row?.status).toBe("error")
      expect(row?.error).not.toBeNull()
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("span row stores attributes as JSON", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(
        Effect.withSpan("attr-span", { attributes: { "cache.hit": true, count: 42 } })
      )
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ attributes: string }>`SELECT attributes FROM spans WHERE name = 'attr-span'`

      expect(rows.length).toBeGreaterThan(0)
      const firstRow = rows[0]
      expect(firstRow).toBeDefined()
      if (firstRow === undefined) return

      const decoded = yield* Schema.decodeUnknown(
        Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Number, Schema.Boolean) }))
      )(firstRow.attributes).pipe(Effect.orDie)

      expect(decoded["cache.hit"]).toBe(true)
      expect(decoded["count"]).toBe(42)
    }).pipe(Effect.provide(makeLayer()))
  )

  it("logs [trace] to console for spans when logConsole is true", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.withSpan("console-span"))
        yield* Effect.promise(drainMicrotasks)
      }).pipe(Effect.provide(makeLayer(true)))
    )

    const calls = spy.mock.calls.slice()
    spy.mockRestore()

    const traceCall = calls.find((c) => {
      const s = c[0] as string
      if (!s.startsWith("[trace] ")) return false
      try { return (JSON.parse(s.slice(8)) as { span?: string }).span === "console-span" } catch { return false }
    })
    expect(traceCall).toBeDefined()
  })

  it.effect("log rows include traceId and spanId when inside a span", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("inside-span-log").pipe(Effect.withSpan("ctx-span"))
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ traceId: string | null; spanId: string | null }>`SELECT traceId, spanId FROM logs WHERE message = 'inside-span-log'`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows[0]
      expect(row).toBeDefined()
      expect(row?.traceId).not.toBeNull()
      expect(row?.spanId).not.toBeNull()
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("log rows have id (TEXT) and seqId (INTEGER)", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("id-test")
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ id: string; seqId: number }>`SELECT id, seqId FROM logs WHERE message = 'id-test'`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows[0]
      expect(row).toBeDefined()
      if (row === undefined) return
      expect(typeof row.id).toBe("string")
      expect(row.id.length).toBeGreaterThan(0)
      expect(typeof row.seqId).toBe("number")
      expect(row.seqId).toBeGreaterThan(0)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("log rows have created and updated fields equal to each other", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("created-updated-test")
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ created: string; updated: string }>`SELECT created, updated FROM logs WHERE message = 'created-updated-test'`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows[0]
      expect(row).toBeDefined()
      if (row === undefined) return
      expect(new Date(row.created).getTime()).not.toBeNaN()
      expect(new Date(row.updated).getTime()).not.toBeNaN()
      expect(row.created).toBe(row.updated)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("span rows have id (TEXT) and seqId (INTEGER)", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("span-id-test"))
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ id: string; seqId: number }>`SELECT id, seqId FROM spans WHERE name = 'span-id-test'`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows[0]
      expect(row).toBeDefined()
      if (row === undefined) return
      expect(typeof row.id).toBe("string")
      expect(row.id.length).toBeGreaterThan(0)
      expect(typeof row.seqId).toBe("number")
      expect(row.seqId).toBeGreaterThan(0)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("span rows have created field as valid ISO string", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("span-created-test"))
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ created: string }>`SELECT created FROM spans WHERE name = 'span-created-test'`

      expect(rows.length).toBeGreaterThan(0)
      const row = rows[0]
      expect(row).toBeDefined()
      if (row === undefined) return
      expect(new Date(row.created).getTime()).not.toBeNaN()
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("migrator creates _collections and _migrations tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ name: string }>`SELECT name FROM _collections ORDER BY name`
      const names = rows.map((r) => r.name)
      expect(names).toContain("logs")
      expect(names).toContain("spans")
    }).pipe(Effect.provide(makeLayer()))
  )
})

describe("logCleanupCronDef", () => {
  function makeCleanupLayer(logRetentionDays: number) {
    const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

    const telemetryClientLayer = Layer.effect(
      TelemetrySqlClient,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return sql
      })
    )

    const appConfigLayer = Layer.succeed(AppConfig, AppConfig.of({
      appName: "test",
      port: 8080,
      applicationUrl: "http://localhost:8080",
      jwtSecret: Redacted.make("test"),
      useS3: false,
      s3Config: Option.none(),
      logRetentionDays,
    }))

    return Layer.mergeAll(
      telemetryClientLayer,
      appConfigLayer
    ).pipe(Layer.provideMerge(sqliteLayer))
  }

  it("has the correct name and description", () => {
    expect(logCleanupCronDef.name).toBe("mira:log-cleanup")
    expect(logCleanupCronDef.description).toBe("Delete logs and spans older than logRetentionDays days")
  })

  it.effect("handler deletes rows older than the retention window from both tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE logs  (id TEXT PRIMARY KEY, created TEXT NOT NULL)`)
      yield* sql.unsafe(`CREATE TABLE spans (id TEXT PRIMARY KEY, created TEXT NOT NULL)`)

      const old    = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()

      yield* sql`INSERT INTO ${sql("logs")}  ${sql.insert({ id: "old-log",   created: old    })}`
      yield* sql`INSERT INTO ${sql("logs")}  ${sql.insert({ id: "new-log",   created: recent })}`
      yield* sql`INSERT INTO ${sql("spans")} ${sql.insert({ id: "old-span",  created: old    })}`
      yield* sql`INSERT INTO ${sql("spans")} ${sql.insert({ id: "new-span",  created: recent })}`

      yield* logCleanupCronDef.handler()

      const logs  = yield* sql<{ id: string }>`SELECT id FROM ${sql("logs")}`
      const spans = yield* sql<{ id: string }>`SELECT id FROM ${sql("spans")}`

      expect(logs.map((r) => r.id)).toEqual(["new-log"])
      expect(spans.map((r) => r.id)).toEqual(["new-span"])
    }).pipe(Effect.provide(makeCleanupLayer(7)))
  )

  it.effect("handler leaves all rows intact when none exceed the retention window", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* sql.unsafe(`CREATE TABLE logs  (id TEXT PRIMARY KEY, created TEXT NOT NULL)`)
      yield* sql.unsafe(`CREATE TABLE spans (id TEXT PRIMARY KEY, created TEXT NOT NULL)`)

      const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()

      yield* sql`INSERT INTO ${sql("logs")}  ${sql.insert({ id: "log-1",  created: recent })}`
      yield* sql`INSERT INTO ${sql("spans")} ${sql.insert({ id: "span-1", created: recent })}`

      yield* logCleanupCronDef.handler()

      const logs  = yield* sql<{ id: string }>`SELECT id FROM ${sql("logs")}`
      const spans = yield* sql<{ id: string }>`SELECT id FROM ${sql("spans")}`

      expect(logs).toHaveLength(1)
      expect(spans).toHaveLength(1)
    }).pipe(Effect.provide(makeCleanupLayer(7)))
  )
})
