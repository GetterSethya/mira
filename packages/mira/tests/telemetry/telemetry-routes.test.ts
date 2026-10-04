import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { NodeCryptoLayer } from "@/crypto/index.js"
import { telemetryLogsRoute, telemetrySpansRoute } from "@/http/telemetry-routes.js"
import { makeSqliteTelemetryLayerForClient } from "@/telemetry/sqlite-logger.js"
import { TelemetrySqlClient } from "@/telemetry/telemetry-sql-client.js"

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function makeRouteLayer() {
  const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })

  const telemetryClientLayer = Layer.effect(TelemetrySqlClient, SqlClient.SqlClient)

  return Layer.mergeAll(
    makeSqliteTelemetryLayerForClient().pipe(Layer.provide(NodeCryptoLayer)),
    telemetryClientLayer
  ).pipe(
    Layer.provideMerge(sqliteLayer)
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

function getBody(res: HttpServerResponse.HttpServerResponse) {
  return Effect.promise(() => HttpServerResponse.toWeb(res).json() as Promise<unknown>)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("telemetryLogsRoute", () => {
  it.effect("returns empty when TelemetrySqlClient absent", () =>
    Effect.gen(function* () {
      const res = yield* runLogsRoute("http://localhost/_telemetry/logs")
      const body = yield* getBody(res)
      expect(body).toMatchObject({ logs: [], total: 0 })
    })
  )

  it.effect("returns written log rows", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("test")
      yield* Effect.promise(drainMicrotasks)

      const res = yield* runLogsRoute("http://localhost/_telemetry/logs")
      const body = yield* getBody(res)

      expect(body).toMatchObject({ total: expect.any(Number) })
      const { logs } = body as { logs: Array<unknown> }
      expect(logs.length).toBeGreaterThan(0)
      const log = (logs as Array<Record<string, unknown>>).find((l) => l["message"] === "test")
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
      const body = yield* getBody(res)

      const { logs, nextCursor, total } = body as { logs: Array<unknown>; total: number; nextCursor: number | null }
      expect(logs.length).toBe(2)
      expect(total).toBeGreaterThanOrEqual(5)
      expect(typeof nextCursor).toBe("number")

      const res2 = yield* runLogsRoute(`http://localhost/_telemetry/logs?limit=2&after=${nextCursor}`)
      const body2 = yield* getBody(res2)
      const { logs: logs2 } = body2 as { logs: Array<unknown> }
      expect(logs2.length).toBe(2)
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("filters by level via FilterNode", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("info-msg")
      yield* Effect.logError("error-msg")
      yield* Effect.promise(drainMicrotasks)

      const filter = JSON.stringify({ op: "eq", field: "level", value: "ERROR" })
      const res = yield* runLogsRoute(`http://localhost/_telemetry/logs?filter=${encodeURIComponent(filter)}`)
      const body = yield* getBody(res)

      const { logs } = body as { logs: Array<Record<string, unknown>> }
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
      const body = yield* getBody(res)

      const { spans } = body as { spans: Array<Record<string, unknown>> }
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
      const body = yield* getBody(res)

      const { spans } = body as { spans: Array<Record<string, unknown>> }
      expect(spans.length).toBeGreaterThanOrEqual(2)
    }).pipe(Effect.provide(makeRouteLayer()))
  )

  it.effect("filters by status via FilterNode", () =>
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("ok-span"))
      yield* Effect.fail("boom").pipe(Effect.withSpan("error-span"), Effect.ignore)
      yield* Effect.promise(drainMicrotasks)

      const filter = JSON.stringify({ op: "eq", field: "status", value: "error" })
      const res = yield* runSpansRoute(`http://localhost/_telemetry/spans?filter=${encodeURIComponent(filter)}`)
      const body = yield* getBody(res)

      const { spans } = body as { spans: Array<Record<string, unknown>> }
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
      const body = yield* getBody(res)
      const { nextCursor, spans, total } = body as { spans: Array<unknown>; total: number; nextCursor: number | null }
      expect(spans.length).toBe(2)
      expect(total).toBeGreaterThanOrEqual(3)
      expect(typeof nextCursor).toBe("number")

      const res2 = yield* runSpansRoute(`http://localhost/_telemetry/spans?limit=2&after=${nextCursor}`)
      const body2 = yield* getBody(res2)
      const { spans: spans2 } = body2 as { spans: Array<unknown> }
      expect(spans2.length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(makeRouteLayer()))
  )
})
