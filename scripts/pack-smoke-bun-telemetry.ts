import { SqliteClient } from "@effect/sql-sqlite-bun"
import {
  BunCryptoLayer,
  makeSqliteTelemetryLayer,
  TelemetrySqlClient
} from "@gettersethya/mira"
import { Effect, Layer } from "effect"

const LOG_MESSAGE = "packed-bun-telemetry-log"
const SPAN_NAME = "packed-bun-telemetry-span"

const telemetryLayer = makeSqliteTelemetryLayer({
  sqlLayer: SqliteClient.layer({ filename: "packed-telemetry.db" })
}).pipe(Layer.provide(BunCryptoLayer))

const program = Effect.gen(function* () {
  yield* Effect.logInfo(LOG_MESSAGE)
  yield* Effect.void.pipe(Effect.withSpan(SPAN_NAME))
  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)))

  const sql = yield* TelemetrySqlClient
  const logs = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM logs WHERE message = ${LOG_MESSAGE}`
  const spans = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM spans WHERE name = ${SPAN_NAME}`

  const logCount = Number(logs[0]?.count ?? 0)
  const spanCount = Number(spans[0]?.count ?? 0)
  if (logCount === 0 || spanCount === 0) {
    throw new Error(`packed telemetry rows missing: logs=${logCount} spans=${spanCount}`)
  }

  return { logs: logCount, spans: spanCount }
})

try {
  const result = await Effect.runPromise(
    program.pipe(Effect.provide(telemetryLayer), Effect.scoped)
  )
  console.log(JSON.stringify({ ok: true, ...result }))
} catch (error) {
  console.error(error)
  process.exit(1)
}
