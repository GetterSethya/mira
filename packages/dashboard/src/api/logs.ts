import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { requireDashboardAuth } from "./auth.js"

export const telemetryStatusRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const sql = yield* SqlClient.SqlClient
  const result = yield* sql<{ exists: number }>`
    SELECT COUNT(*) as exists FROM sqlite_master WHERE type='table' AND name='logs'
  `.pipe(Effect.catchAll(() => Effect.succeed([{ exists: 0 }])))

  const configured = result[0].exists > 0

  return HttpServerResponse.unsafeJson({
    configured,
    message: configured
      ? undefined
      : "SQLite telemetry not configured. Use makeSqliteTelemetryLayer() and restart the app.",
  })
})

export const logsRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const sql = yield* SqlClient.SqlClient
  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 1000)
  const offset = Number(url.searchParams.get("offset") ?? "0")
  const level = url.searchParams.get("level")

  const tableCheck = yield* sql<{ exists: number }>`
    SELECT COUNT(*) as exists FROM sqlite_master WHERE type='table' AND name='logs'
  `.pipe(Effect.catchAll(() => Effect.succeed([{ exists: 0 }])))

  if (tableCheck[0].exists === 0) {
    return HttpServerResponse.unsafeJson({
      logs: [],
      total: 0,
      error: "SQLite telemetry not configured. Use makeSqliteTelemetryLayer() and restart the app.",
    })
  }

  const logs = yield* level
    ? sql<{
        id: number
        level: string
        message: string
        timestamp: string
        traceId: string | null
        spanId: string | null
      }>`
        SELECT * FROM ${sql("logs")}
        WHERE level = ${level}
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : sql<{
        id: number
        level: string
        message: string
        timestamp: string
        traceId: string | null
        spanId: string | null
      }>`
        SELECT * FROM ${sql("logs")}
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}
      `

  const total = yield* level
    ? sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM ${sql("logs")} WHERE level = ${level}`
    : sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM ${sql("logs")}`

  return HttpServerResponse.unsafeJson({
    logs,
    total: total[0].cnt,
    limit,
    offset,
  })
})
