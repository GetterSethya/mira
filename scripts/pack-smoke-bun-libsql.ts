import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LibsqlDatabase, TursoDatabase } from "@gettersethya/mira"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

if (TursoDatabase !== LibsqlDatabase) {
  throw new Error("TursoDatabase is not the LibsqlDatabase alias")
}

const directory = mkdtempSync(join(tmpdir(), "mira-pack-bun-libsql-"))
const filename = join(directory, "smoke.db").replaceAll("\\", "/")
const layer = LibsqlDatabase({ url: `file:${filename}`, synchronous: "NORMAL" }).layer

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE smoke (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`
  yield* sql`INSERT INTO smoke (name) VALUES (${"bun-packed"})`
  const rows = yield* sql`SELECT name FROM smoke`
  if (rows.length !== 1 || rows[0]?.["name"] !== "bun-packed") {
    throw new Error(`unexpected libSQL rows: ${encodeJson(rows)}`)
  }
})

try {
  await Effect.runPromise(program.pipe(Effect.provide(layer)))
  console.log("pack bun libsql smoke ok")
} finally {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // Windows can keep the native libSQL handle briefly.
  }
}
