import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LibsqlDatabase } from "@gettersethya/mira"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

const dir = mkdtempSync(join(tmpdir(), "mira-pack-libsql-"))
const filename = join(dir, "libsql.db").replaceAll("\\", "/")
const layer = LibsqlDatabase({ url: `file:${filename}` }).layer

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE smoke (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)`
  yield* sql`INSERT INTO smoke (name) VALUES (${"packed"})`
  const rows = yield* sql`SELECT name FROM smoke`
  if (rows.length !== 1 || rows[0]?.name !== "packed") {
    throw new Error(`unexpected libSQL rows: ${JSON.stringify(rows)}`)
  }
})

await Effect.runPromise(program.pipe(Effect.provide(layer)))
console.log("pack libsql smoke ok")
