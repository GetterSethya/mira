import { BunCryptoLayer, BunSqliteDatabase, makeTelemetryLayer, TelemetryStore } from "@gettersethya/mira/bun"
import { Effect, Layer, Schema } from "effect"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const LOG_MESSAGE = "packed-bun-telemetry-log"
const SPAN_NAME = "packed-bun-telemetry-span"

const telemetryLayer = makeTelemetryLayer({
  storage: {
    mode: "dedicated",
    database: BunSqliteDatabase({ filename: "packed-telemetry.db" })
  }
}).pipe(Layer.provide(BunSqliteDatabase({ filename: "packed-app.db" }).layer), Layer.provide(BunCryptoLayer))

const program = Effect.gen(function* () {
  yield* Effect.logInfo(LOG_MESSAGE)
  yield* Effect.void.pipe(Effect.withSpan(SPAN_NAME))
  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)))

  const store = yield* TelemetryStore
  if (store.read === null) throw new Error("packed telemetry store has no read capability")
  const logs = yield* store.read.listLogs({
    limit: 1000,
    after: null,
    filter: null,
    traceId: null
  })
  const spans = yield* store.read.listSpans({
    limit: 1000,
    after: null,
    filter: null,
    traceId: null
  })

  const logCount = logs.items.filter((row) => row.message === LOG_MESSAGE).length
  const spanCount = spans.items.filter((row) => row.name === SPAN_NAME).length
  if (logCount === 0 || spanCount === 0) {
    throw new Error(`packed telemetry rows missing: logs=${logCount} spans=${spanCount}`)
  }

  return { logs: logCount, spans: spanCount }
})

try {
  const result = await Effect.runPromise(program.pipe(Effect.provide(telemetryLayer), Effect.scoped))
  console.log(encodeJson({ ok: true, ...result }))
} catch (error) {
  console.error(error)
  process.exit(1)
}
