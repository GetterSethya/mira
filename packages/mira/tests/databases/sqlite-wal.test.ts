import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, expect } from "vitest"

import { SqliteDatabase } from "@/databases/sqlite.js"

const directory = mkdtempSync(join(tmpdir(), "mira-sqlite-wal-"))
const filename = join(directory, "app.db")

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

const journalMode = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`
  return rows[0]?.journal_mode
})

describe("SqliteDatabase WAL mode", () => {
  it.effect("enables WAL on file-backed databases by default", () =>
    journalMode.pipe(
      Effect.provide(SqliteDatabase({ filename }).layer),
      Effect.map((mode) => expect(mode).toBe("wal"))
    )
  )

  it.effect("keeps WAL enabled when a synchronous mode is configured", () =>
    Effect.gen(function* () {
      const mode = yield* journalMode
      const synchronous = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ synchronous: number }>`PRAGMA synchronous`
      })
      expect(mode).toBe("wal")
      expect(synchronous[0]?.synchronous).toBe(1)
    }).pipe(Effect.provide(SqliteDatabase({ filename: join(directory, "normal.db"), synchronous: "NORMAL" }).layer))
  )
})
