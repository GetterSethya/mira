import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { TelemetrySqlClient } from "@/telemetry/telemetry-sql-client.js"

const SpanAttributeValueSchema = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)
const SpanAttributesSchema = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: SpanAttributeValueSchema })
)
const parseAttributes = Schema.decodeUnknown(SpanAttributesSchema)

type RawSpanRow = {
  id: number
  name: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  kind: string
  durationMs: number
  status: "ok" | "error"
  error: string | null
  attributes: string
  timestamp: string
}

const parseSpanRow = (raw: RawSpanRow) =>
  parseAttributes(raw.attributes).pipe(
    Effect.orElseSucceed((): Record<string, string | number | boolean> => ({})),
    Effect.map((attributes) => ({
      id: raw.id,
      name: raw.name,
      traceId: raw.traceId,
      spanId: raw.spanId,
      parentSpanId: raw.parentSpanId,
      kind: raw.kind,
      durationMs: raw.durationMs,
      status: raw.status,
      error: raw.error,
      attributes,
      timestamp: raw.timestamp,
    }))
  )

function notConfiguredResponse() {
  return HttpServerResponse.unsafeJson({
    logs: [],
    total: 0,
    limit: 0,
    offset: 0,
    error: "SQLite telemetry not configured. Use makeSqliteTelemetryLayer() and restart the app.",
  })
}

export const telemetryLogsRoute = Effect.gen(function* () {
  const sqlOpt = yield* Effect.serviceOption(TelemetrySqlClient)
  if (Option.isNone(sqlOpt)) {
    return notConfiguredResponse()
  }
  const sql = sqlOpt.value

  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 1000)
  const offset = Number(url.searchParams.get("offset") ?? "0")
  const level = url.searchParams.get("level")

  const tableCheck = yield* sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='logs'
  `.pipe(Effect.catchAll(() => Effect.succeed([{ cnt: 0 }])))

  if (tableCheck[0].cnt === 0) {
    return notConfiguredResponse()
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

export const telemetrySpansRoute = Effect.gen(function* () {
  const sqlOpt = yield* Effect.serviceOption(TelemetrySqlClient)
  if (Option.isNone(sqlOpt)) {
    return HttpServerResponse.unsafeJson({ spans: [], total: 0, limit: 0, offset: 0 })
  }
  const sql = sqlOpt.value

  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const limitParam = Number(url.searchParams.get("limit") ?? "50")
  const limit = Math.max(1, Math.min(limitParam, 200))
  const offset = Number(url.searchParams.get("offset") ?? "0")
  const traceId = url.searchParams.get("traceId")

  const tableCheck = yield* sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='spans'
  `.pipe(Effect.catchAll(() => Effect.succeed([{ cnt: 0 }])))

  if (tableCheck[0].cnt === 0) {
    return HttpServerResponse.unsafeJson({ spans: [], total: 0, limit, offset })
  }

  if (traceId !== null) {
    const rawSpans = yield* sql<RawSpanRow>`
      SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, timestamp
      FROM ${sql("spans")}
      WHERE traceId = ${traceId}
      ORDER BY timestamp ASC
    `
    const spans = yield* Effect.all(rawSpans.map(parseSpanRow), { concurrency: "unbounded" })
    return HttpServerResponse.unsafeJson({ spans, total: spans.length, limit, offset })
  }

  // Paginate by trace (root spans), then return all child spans for those traces.
  // This guarantees complete traces are returned rather than partial span slices.
  const rawSpans = yield* sql<RawSpanRow>`
    SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, timestamp
    FROM ${sql("spans")}
    WHERE traceId IN (
      SELECT traceId FROM ${sql("spans")}
      WHERE parentSpanId IS NULL
      ORDER BY timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    )
    ORDER BY timestamp ASC
  `
  const total = yield* sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt FROM ${sql("spans")} WHERE parentSpanId IS NULL
  `
  const spans = yield* Effect.all(rawSpans.map(parseSpanRow), { concurrency: "unbounded" })

  return HttpServerResponse.unsafeJson({ spans, total: total[0].cnt, limit, offset })
})
