import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, expect } from "vitest"

import { LibsqlDatabase } from "@/databases/libsql.js"
import { makeSqlTelemetryStoreLayer } from "@/telemetry/sql-store.js"
import { TelemetryStore } from "@/telemetry/store.js"

const fileUrl = (filename: string) => `file:${filename.replaceAll("\\", "/")}`

const dirs: Array<string> = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe("libSQL telemetry retention", () => {
  it.effect("deletes by seqId above 2^53 without returning the seqId", () => {
    const dir = tempDir("mira-libsql-retention-")
    const database = LibsqlDatabase({ url: fileUrl(join(dir, "telemetry.db")) })
    const layer = makeSqlTelemetryStoreLayer({ dedicated: true }).pipe(
      Layer.provideMerge(database.layer)
    )

    return Effect.gen(function* () {
      const store = yield* TelemetryStore
      const sql = yield* SqlClient.SqlClient
      const old = "2026-11-20T00:00:00.000Z"
      const cutoff = "2026-11-25T00:00:00.000Z"
      const recent = "2026-11-26T00:00:00.000Z"

      yield* sql.unsafe(
        `INSERT INTO "logs" ("seqId", "id", "level", "message", "created", ` +
          `"updated", "traceId", "spanId") VALUES ` +
          `(9007199254740993, 'big-old', 'INFO', 'old', ?, ?, NULL, NULL), ` +
          `(9007199254740994, 'big-recent', 'INFO', 'recent', ?, ?, NULL, NULL)`,
        [old, old, recent, recent]
      )

      const deleted = yield* store.deleteOlderThan(cutoff)
      expect(deleted).toEqual({ logs: 1, spans: 0 })

      const remaining = yield* sql.unsafe<{ seqId: string; id: string }>(
        'SELECT CAST("seqId" AS TEXT) AS "seqId", "id" FROM "logs"'
      )
      expect(remaining).toEqual([{ seqId: "9007199254740994", id: "big-recent" }])
    }).pipe(Effect.provide(layer))
  })
})
