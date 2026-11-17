import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { Dialect, type DialectType, errorHasCode } from "@/dialect/dialect.js"
import { libsqlConnectionMode, libsqlDialect } from "@/dialect/dialect-libsql.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { makeSqlTelemetryStoreLayer } from "@/telemetry/sql-store.js"
import { TelemetryStore } from "@/telemetry/store.js"

const busyError = {
  reason: { _tag: "LockTimeoutError", cause: { code: "SQLITE_BUSY" } }
}

const uniqueError = {
  reason: { _tag: "SqlError", cause: { code: "SQLITE_CONSTRAINT_UNIQUE" } }
}

describe("SQLite telemetry hooks", () => {
  it("declares setup, cleanup, retry, and duplicate predicates", () => {
    expect(sqliteDialect.telemetry?.setup).toEqual([
      "PRAGMA journal_mode = WAL",
      "PRAGMA synchronous = NORMAL",
      "PRAGMA busy_timeout = 5000"
    ])
    expect(sqliteDialect.telemetry?.cleanup).toEqual(["PRAGMA wal_checkpoint(TRUNCATE)"])
    expect(sqliteDialect.telemetry?.isRetryable(busyError)).toBe(true)
    expect(sqliteDialect.telemetry?.isRetryable({ reason: { _tag: "Other" } })).toBe(false)
    expect(sqliteDialect.telemetry?.isDuplicateKey(uniqueError)).toBe(true)
    expect(sqliteDialect.telemetry?.isDuplicateKey(busyError)).toBe(false)
  })

  it("provides a placeholder and a quote-safe upsert", () => {
    expect(sqliteDialect.placeholder(1)).toBe("?")
    const sql = sqliteDialect.upsert(
      "_collections",
      { name: "logs", schema: `{"quote":"it's \\\\ ok"}`, updated_at: "now" },
      ["name"]
    )
    expect(sql).toContain('INSERT INTO "_collections"')
    expect(sql).toContain('ON CONFLICT ("name")')
    expect(sql).toContain("excluded")
    expect(sql).toContain("it''s")
  })

  it("recognizes nested driver codes", () => {
    expect(errorHasCode(busyError, ["SQLITE_BUSY"])).toBe(true)
    expect(errorHasCode({ cause: { reason: { errno: 2067 } } }, [2067])).toBe(true)
    expect(errorHasCode({}, ["SQLITE_BUSY"])).toBe(false)
  })
})

const recordingLayer = (statements: Array<string>) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const base = yield* SqlClient.SqlClient
      return new Proxy(base, {
        get(target, property, receiver) {
          if (property === "unsafe") {
            return (sql: string, params?: ReadonlyArray<unknown>) => {
              statements.push(sql)
              return target.unsafe(sql, params)
            }
          }
          return Reflect.get(target, property, receiver)
        }
      })
    })
  )

describe("libSQL telemetry hooks", () => {
  it("classifies local and remote URLs", () => {
    expect(libsqlConnectionMode(":memory:")).toBe("local")
    expect(libsqlConnectionMode("file:./data.db")).toBe("local")
    expect(libsqlConnectionMode("libsql://example.turso.io")).toBe("remote")
    expect(libsqlConnectionMode("https://example.turso.io")).toBe("remote")
    expect(libsqlConnectionMode("wss://example.turso.io")).toBe("remote")
    expect(() => libsqlConnectionMode("postgres://example")).toThrow()
  })

  it("reuses the SQLite dialect locally and clears remote setup", () => {
    expect(libsqlDialect("local")).toBe(sqliteDialect)
    expect(libsqlDialect("remote").telemetry?.setup).toEqual([])
    expect(libsqlDialect("remote").telemetry?.cleanup).toEqual([])
  })

  it("retries nested network and SQLite lock errors, and keeps the duplicate classifier", () => {
    const remote = libsqlDialect("remote").telemetry!
    expect(remote.isRetryable({ reason: { cause: { code: "ECONNREFUSED" } } })).toBe(true)
    expect(remote.isRetryable({ cause: { cause: { code: "SQLITE_BUSY" } } })).toBe(true)
    expect(remote.isRetryable({ reason: { _tag: "Other" } })).toBe(false)
    expect(remote.isDuplicateKey(uniqueError)).toBe(true)
    expect(remote.isDuplicateKey(busyError)).toBe(false)
  })
})

describe("dialect-neutral store setup", () => {
  it.effect("does not emit PRAGMA when the dialect has no telemetry hooks", () => {
    const statements: Array<string> = []
    const { telemetry: _telemetry, ...rest } = sqliteDialect
    void _telemetry
    const fake = rest as DialectType
    const database = Layer.merge(
      recordingLayer(statements).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
      Layer.succeed(Dialect, fake)
    )
    const layer = makeSqlTelemetryStoreLayer({ dedicated: true }).pipe(
      Layer.provideMerge(database)
    )

    return Effect.gen(function* () {
      const store = yield* TelemetryStore
      expect(store.read).not.toBeNull()
      expect(statements.some((statement) => statement.includes("PRAGMA"))).toBe(false)
    }).pipe(Effect.provide(layer))
  })
})
