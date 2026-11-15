import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { SqliteDatabase } from "@/databases/sqlite.js"

const pragmaSynchronous = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`PRAGMA synchronous`
  return rows[0]["synchronous"]
})

const withDatabase = (synchronous?: "FULL" | "NORMAL" | "OFF") =>
  synchronous === undefined
    ? pragmaSynchronous.pipe(Effect.provide(SqliteDatabase({ filename: ":memory:" }).layer))
    : pragmaSynchronous.pipe(
        Effect.provide(SqliteDatabase({ filename: ":memory:", synchronous }).layer)
      )

describe("SqliteDatabase synchronous mode", () => {
  it.effect("leaves the driver default (FULL) when omitted", () =>
    Effect.gen(function* () {
      expect(yield* withDatabase()).toBe(2)
    }))

  it.effect("applies PRAGMA synchronous = FULL", () =>
    Effect.gen(function* () {
      expect(yield* withDatabase("FULL")).toBe(2)
    }))

  it.effect("applies PRAGMA synchronous = NORMAL", () =>
    Effect.gen(function* () {
      expect(yield* withDatabase("NORMAL")).toBe(1)
    }))

  it.effect("applies PRAGMA synchronous = OFF", () =>
    Effect.gen(function* () {
      expect(yield* withDatabase("OFF")).toBe(0)
    }))
})
