import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { requireDashboardAuth } from "./auth.js"

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

export const spansRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const sql = yield* SqlClient.SqlClient
  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const limitParam = Number(url.searchParams.get("limit") ?? "100")
  const limit = Math.max(1, Math.min(limitParam, 500))
  const offset = Number(url.searchParams.get("offset") ?? "0")
  const traceId = url.searchParams.get("traceId")

  const tableCheck = yield* sql<{ exists: number }>`
    SELECT COUNT(*) as exists FROM sqlite_master WHERE type='table' AND name='spans'
  `.pipe(Effect.catchAll(() => Effect.succeed([{ exists: 0 }])))

  if (tableCheck[0].exists === 0) {
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

  const rawSpans = yield* sql<RawSpanRow>`
    SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, timestamp
    FROM ${sql("spans")}
    ORDER BY timestamp DESC
    LIMIT ${limit} OFFSET ${offset}
  `
  const total = yield* sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM ${sql("spans")}`
  const spans = yield* Effect.all(rawSpans.map(parseSpanRow), { concurrency: "unbounded" })

  return HttpServerResponse.unsafeJson({ spans, total: total[0].cnt, limit, offset })
})
