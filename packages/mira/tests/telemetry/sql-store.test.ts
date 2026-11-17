import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { makeSqlTelemetryStoreLayer } from "@/telemetry/sql-store.js"
import {
  type TelemetryLogEntry,
  type TelemetrySpanEntry,
  type TelemetryStoreShape,
  TelemetryStore,
  TelemetryStoreError
} from "@/telemetry/store.js"

const databaseLayer = (dialect = sqliteDialect) =>
  Layer.merge(
    SqliteClient.layer({ filename: ":memory:" }),
    Layer.succeed(Dialect, dialect)
  )

const makeLayer = (dialect = sqliteDialect) =>
  makeSqlTelemetryStoreLayer({ dedicated: true }).pipe(
    Layer.provideMerge(databaseLayer(dialect))
  )

const log = (
  id: string,
  message = id,
  created = new Date().toISOString()
): TelemetryLogEntry => ({
  id,
  level: "INFO",
  message,
  created,
  updated: created,
  traceId: null,
  spanId: null
})

const span = (
  id: string,
  traceId: string,
  created = new Date().toISOString()
): TelemetrySpanEntry => ({
  id,
  name: id,
  traceId,
  spanId: `span-${id}`,
  parentSpanId: null,
  kind: "internal",
  durationMs: 1,
  status: "ok",
  error: null,
  attributes: { id },
  created,
  updated: created
})

const count = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql.unsafe<{ count: number }>(
      `SELECT COUNT(*) AS count FROM "${table}"`
    )
    return Number(rows[0]?.count ?? 0)
  })

const requireRead = (store: TelemetryStoreShape) => {
  if (store.read === null) {
    throw new Error("expected the SQL telemetry store to expose reads")
  }
  return store.read
}

describe("SqlTelemetryStore", () => {
  it.effect("appends and reads logs without changing the public shape", () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const read = requireRead(store)
      yield* store.appendLogs([log("one", "first"), log("two", "second")])

      const page = yield* read.listLogs({
        limit: 10,
        after: null,
        filter: null,
        traceId: null
      })

      expect(page.total).toBe(2)
      expect(page.items.map((row) => row.id).sort()).toEqual(["one", "two"])
      expect(page.items.every((row) => typeof row.seqId === "number")).toBe(true)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("is idempotent when the same batch is appended twice", () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const rows = [log("dup-1"), log("dup-2")]

      yield* store.appendLogs(rows)
      yield* store.appendLogs(rows)

      expect(yield* count("logs")).toBe(2)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("deletes only rows older than the cutoff and returns actual counts", () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const read = requireRead(store)
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()

      yield* store.appendLogs([log("old", "old", old), log("recent", "recent", recent)])
      yield* store.appendSpans([span("old-span", "trace-old", old), span("recent-span", "trace-recent", recent)])

      const deleted = yield* store.deleteOlderThan(recent)
      expect(deleted.logs).toBe(1)
      expect(deleted.spans).toBe(1)

      const logs = yield* read.listLogs({
        limit: 10,
        after: null,
        filter: null,
        traceId: null
      })
      expect(logs.items.map((row) => row.id)).toEqual(["recent"])
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("rejects retention when the dialect cannot report affected rows", () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const error = yield* store.deleteOlderThan(new Date().toISOString()).pipe(Effect.flip)
      expect(error).toBeInstanceOf(TelemetryStoreError)
    }).pipe(
      Effect.provide(
        makeLayer({
          ...sqliteDialect,
          deleteResult: { _tag: "precheck" }
        })
      )
    )
  )

  it.effect("preserves log filters and cursors", () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const read = requireRead(store)
      yield* store.appendLogs([
        { ...log("a"), level: "INFO" },
        { ...log("b"), level: "ERROR" },
        { ...log("c"), level: "ERROR" }
      ])

      const filtered = yield* read.listLogs({
        limit: 1,
        after: null,
        filter: { op: "eq", field: "level", value: "ERROR" },
        traceId: null
      })
      expect(filtered.total).toBe(2)
      expect(filtered.items).toHaveLength(1)
      expect(filtered.items[0]?.level).toBe("ERROR")
      expect(typeof filtered.nextCursor).toBe("number")

      const next = yield* read.listLogs({
        limit: 1,
        after: filtered.nextCursor,
        filter: { op: "eq", field: "level", value: "ERROR" },
        traceId: null
      })
      expect(next.items).toHaveLength(1)
      expect(next.items[0]?.id).not.toBe(filtered.items[0]?.id)
    }).pipe(Effect.provide(makeLayer()))
  )

  it.effect("groups spans by trace and keeps seqId out of the public row", () =>
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const read = requireRead(store)
      yield* store.appendSpans([
        span("a1", "trace-a"),
        span("a2", "trace-a"),
        span("b1", "trace-b")
      ])

      const page = yield* read.listSpans({
        limit: 10,
        after: null,
        filter: null,
        traceId: null
      })

      expect(page.total).toBe(2)
      expect(page.items).toHaveLength(3)
      expect(page.items.every((row) => !("seqId" in row))).toBe(true)

      const trace = yield* read.listSpans({
        limit: 10,
        after: null,
        filter: null,
        traceId: "trace-a"
      })
      expect(trace.total).toBe(2)
      expect(trace.nextCursor).toBeNull()
    }).pipe(Effect.provide(makeLayer()))
  )


})
