import { FilterNodeSchema } from "@gettersethya/mira-client"
import { describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { NodeCryptoLayer } from "@/crypto/index.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { telemetryLogsRoute, telemetrySpansRoute } from "@/http/telemetry-routes.js"
import { makeTelemetryLayerForClient } from "@/telemetry/core.js"
import { makeSqlTelemetryStoreLayer } from "@/telemetry/sql-store.js"

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)

const LogsBody = Schema.Struct({
  logs: Schema.Array(JsonRecord),
  total: Schema.Number,
  nextCursor: Schema.NullOr(Schema.Number)
})

const SpansBody = Schema.Struct({
  spans: Schema.Array(JsonRecord),
  total: Schema.Number,
  nextCursor: Schema.NullOr(Schema.Number)
})

const encodeFilter = Schema.encodeSync(Schema.fromJsonString(FilterNodeSchema))

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function makeRouteLayer() {
  const database = SqliteDatabase({ filename: ":memory:" })
  const store = makeSqlTelemetryStoreLayer({ dedicated: true }).pipe(
    Layer.provide(database.layer)
  )

  return makeTelemetryLayerForClient().pipe(
    Layer.provideMerge(store),
    Layer.provideMerge(database.layer),
    Layer.provide(NodeCryptoLayer)
  )
}

async function drainMicrotasks() {
  await new Promise((r) => setTimeout(r, 20))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runLogsRoute(url: string) {
  const req = HttpServerRequest.fromWeb(new Request(url))
  return telemetryLogsRoute.pipe(
    Effect.provide(Layer.succeed(HttpServerRequest.HttpServerRequest, req))
  )
}

function runSpansRoute(url: string) {
  const req = HttpServerRequest.fromWeb(new Request(url))
  return telemetrySpansRoute.pipe(
    Effect.provide(Layer.succeed(HttpServerRequest.HttpServerRequest, req))
  )
}

function getBody<A>(
  res: HttpServerResponse.HttpServerResponse,
  schema: Schema.Schema<A>
): Effect.Effect<A, Schema.SchemaError, never> {
  // The route test intentionally decodes arbitrary response JSON; the runtime
  // graph is closed, but Schema's generic widens the environment.
  // oxlint-disable-next-line typescript/consistent-type-assertions
  return Effect.promise(() => HttpServerResponse.toWeb(res).json()).pipe(
    Effect.flatMap((body: unknown) => Schema.decodeUnknownEffect(schema)(body))
  ) as Effect.Effect<A, Schema.SchemaError, never>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telemetryLogsRoute", () => {
  it.effect("returns disabled when TelemetryStore absent", () =>
    Effect.gen(function* () {
      const res = yield* runLogsRoute("http://localhost/_telemetry/logs")
      const body = yield* getBody(res, LogsBody)
      expect(body).toMatchObject({ logs: [], total: 0 })
    })
  )

  it.effect("returns written log rows", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("test")
      yield* Effect.promise(drainMicrotasks)

      const res = yield* runLogsRoute("http://localhost/_telemetry/logs")
      const body = yield* getBody(res, LogsBody)

      expect(body).toMatchObject({ total: expect.any(Number) })
      const { logs } = body
      expect(logs.length).toBeGreaterThan(0)
      const log = logs.find((l) => l["message"] === "test")
      expect(log).toBeDefined()
      expect(log?.["level"]).toBe("INFO")
      expect(typeof log?.["created"]).toBe("string")
      expect(typeof log?.["id"]).toBe("string")
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("paginates with limit and after cursor", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 5; i++) {
        yield* Effect.logInfo(`log-${i}`)
      }
      yield* Effect.promise(drainMicrotasks)

      const res = yield* runLogsRoute("http://localhost/_telemetry/logs?limit=2")
      const body = yield* getBody(res, LogsBody)

      const { logs, nextCursor, total } = body
      expect(logs.length).toBe(2)
      expect(total).toBeGreaterThanOrEqual(5)
      expect(typeof nextCursor).toBe("number")

      const res2 = yield* runLogsRoute(`http://localhost/_telemetry/logs?limit=2&after=${nextCursor}`)
      const body2 = yield* getBody(res2, LogsBody)
      const { logs: logs2 } = body2
      expect(logs2.length).toBe(2)
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("filters by level via FilterNode", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("info-msg")
      yield* Effect.logError("error-msg")
      yield* Effect.promise(drainMicrotasks)

      const filter = encodeFilter({ op: "eq", field: "level", value: "ERROR" })
      const res = yield* runLogsRoute(`http://localhost/_telemetry/logs?filter=${encodeURIComponent(filter)}`)
      const body = yield* getBody(res, LogsBody)

      const { logs } = body
      expect(logs.length).toBeGreaterThan(0)
      for (const log of logs) {
        expect(log["level"]).toBe("ERROR")
      }
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("returns 400 on invalid filter JSON", () =>
    Effect.gen(function* () {
      const res = yield* runLogsRoute("http://localhost/_telemetry/logs?filter=notjson")
      expect(res.status).toBe(400)
    }).pipe(Effect.provide(makeRouteLayer()))
  )
})

describe("telemetrySpansRoute", () => {
  it.effect("returns written span rows", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("my-span"))
      yield* Effect.promise(drainMicrotasks)

      const res = yield* runSpansRoute("http://localhost/_telemetry/spans")
      const body = yield* getBody(res, SpansBody)

      const { spans } = body
      expect(spans.length).toBeGreaterThan(0)
      const span = spans.find((s) => s["name"] === "my-span")
      expect(span).toBeDefined()
      expect(typeof span?.["id"]).toBe("string")
      expect(typeof span?.["created"]).toBe("string")
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("?traceId= fast path returns all spans for the trace", () =>
    Effect.gen(function* () {
      let capturedTraceId = ""
      yield* Effect.void.pipe(
        Effect.withSpan("child-span"),
        Effect.withSpan("parent-span")
      )
      yield* Effect.promise(drainMicrotasks)

      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ traceId: string }>`SELECT traceId FROM spans WHERE name = 'parent-span' LIMIT 1`
      expect(rows.length).toBeGreaterThan(0)
      if (rows[0] !== undefined) capturedTraceId = rows[0].traceId

      const res = yield* runSpansRoute(`http://localhost/_telemetry/spans?traceId=${encodeURIComponent(capturedTraceId)}`)
      const body = yield* getBody(res, SpansBody)

      const { spans } = body
      expect(spans.length).toBeGreaterThanOrEqual(2)
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("filters by status via FilterNode", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("ok-span"))
      yield* Effect.fail("boom").pipe(Effect.withSpan("error-span"), Effect.ignore)
      yield* Effect.promise(drainMicrotasks)

      const filter = encodeFilter({ op: "eq", field: "status", value: "error" })
      const res = yield* runSpansRoute(`http://localhost/_telemetry/spans?filter=${encodeURIComponent(filter)}`)
      const body = yield* getBody(res, SpansBody)

      const { spans } = body
      expect(spans.length).toBeGreaterThan(0)
      for (const span of spans) {
        expect(span["status"]).toBe("error")
      }
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("returns 400 on invalid filter", () =>
    Effect.gen(function* () {
      const res = yield* runSpansRoute("http://localhost/_telemetry/spans?filter=bad")
      expect(res.status).toBe(400)
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("paginates spans with limit and after cursor", () =>
    Effect.gen(function* () {
      yield* Effect.withSpan("span-1")(Effect.void)
      yield* Effect.withSpan("span-2")(Effect.void)
      yield* Effect.withSpan("span-3")(Effect.void)
      yield* Effect.promise(drainMicrotasks)

      const res = yield* runSpansRoute("http://localhost/_telemetry/spans?limit=2")
      const body = yield* getBody(res, SpansBody)
      const { nextCursor, spans, total } = body
      expect(spans.length).toBe(2)
      expect(total).toBeGreaterThanOrEqual(3)
      expect(typeof nextCursor).toBe("number")

      const res2 = yield* runSpansRoute(`http://localhost/_telemetry/spans?limit=2&after=${nextCursor}`)
      const body2 = yield* getBody(res2, SpansBody)
      const { spans: spans2 } = body2
      expect(spans2.length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(makeRouteLayer()))
  )
})
