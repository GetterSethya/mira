import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LibsqlDatabase, TursoDatabase } from "@gettersethya/mira/bun"
import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

const encodeRows = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.Finite, name: Schema.String })))
)

if (TursoDatabase !== LibsqlDatabase) {
  throw new Error("TursoDatabase is not the LibsqlDatabase alias")
}

const directory = mkdtempSync(join(tmpdir(), "mira-bun-libsql-"))
const localUrl = `file:${join(directory, "smoke.db").replaceAll("\\", "/")}`
const url = Bun.env["LIBSQL_URL"] ?? Bun.env["MIRA_LIBSQL_URL"] ?? localUrl
const isLocal = url.startsWith("file:")

const layer = LibsqlDatabase({
  url,
  synchronous: isLocal ? "NORMAL" : undefined
}).layer

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE IF EXISTS bun_libsql_smoke`
  yield* sql`CREATE TABLE bun_libsql_smoke (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`
  yield* sql`INSERT INTO bun_libsql_smoke (name) VALUES (${"bun-libsql"})`
  const rows = yield* sql<{ readonly id: number; readonly name: string }>`SELECT id, name FROM bun_libsql_smoke`
  const pragmas = isLocal
    ? yield* Effect.all([
        sql.unsafe<{ foreign_keys: number }>("PRAGMA foreign_keys"),
        sql.unsafe<{ timeout: number }>("PRAGMA busy_timeout")
      ])
    : []
  return { rows, pragmas }
})

try {
  const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))
  if (result.rows.length !== 1 || result.rows[0]?.["name"] !== "bun-libsql") {
    throw new Error(`unexpected libSQL rows: ${encodeRows(result.rows)}`)
  }
  if (isLocal) {
    if (result.pragmas[0]?.[0]?.["foreign_keys"] !== 0) {
      throw new Error("local libSQL did not disable foreign keys")
    }
    if (result.pragmas[1]?.[0]?.["timeout"] !== 5000) {
      throw new Error("local libSQL did not set busy_timeout=5000")
    }
  }
  console.log(`bun libsql smoke ok (${isLocal ? "local" : "remote"}): ${encodeRows(result.rows)}`)
} finally {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // Windows can keep the native libSQL handle briefly. The OS temp cleanup
    // still applies.
  }
}
