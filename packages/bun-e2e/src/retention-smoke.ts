import {
  BunSqliteDatabase,
  makeSqlTelemetryStoreLayer,
  TelemetryStore
} from "@gettersethya/mira/bun"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

const database = BunSqliteDatabase({ filename: ":memory:" })
const storeLayer = makeSqlTelemetryStoreLayer({ dedicated: true }).pipe(
  Layer.provideMerge(database.layer)
)

const old = "2026-11-20T00:00:00.000Z"
const cutoff = "2026-11-25T00:00:00.000Z"
const recent = "2026-11-26T00:00:00.000Z"

const log = (id: string, created: string) => ({
  id,
  level: "INFO",
  message: id,
  created,
  updated: created,
  traceId: null,
  spanId: null
})

const program = Effect.gen(function* () {
  const ctx = yield* Layer.build(storeLayer)
  const store = Context.get(ctx, TelemetryStore)
  const sql = Context.get(ctx, SqlClient.SqlClient)

  yield* store
    .appendLogs([
      log("old", old),
      log("recent", recent),
      log("cutoff", cutoff)
    ])
    .pipe(Effect.provide(ctx))

  const deleted = yield* store.deleteOlderThan(cutoff).pipe(Effect.provide(ctx))
  if (deleted.logs !== 1 || deleted.spans !== 0) {
    throw new Error(`unexpected retention counts: ${JSON.stringify(deleted)}`)
  }

  const rows = yield* sql
    .unsafe<{ id: string }>('SELECT "id" FROM "logs" ORDER BY "id"')
    .pipe(Effect.provide(ctx))
  const ids = rows.map((row) => row.id)
  if (ids.length !== 2 || ids[0] !== "cutoff" || ids[1] !== "recent") {
    throw new Error(`unexpected remaining logs: ${JSON.stringify(ids)}`)
  }
})

await Effect.runPromise(Effect.scoped(program))
console.log("bun retention ok")
