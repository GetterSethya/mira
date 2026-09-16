import { Data, Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { unsafeFragment } from "@effect/sql/Statement"
import type { FilterNode } from "@gettersethya/mira-client"
import { FilterNodeSchema, filterNodeToWhereClause } from "@gettersethya/mira-client"
import { TelemetrySqlClient } from "@/telemetry/telemetry-sql-client.js"
import { LogsCollection, SpansCollection } from "@/telemetry/collections.js"

// ---------------------------------------------------------------------------
// Tagged error for JSON / schema parse failures in the filter param
// ---------------------------------------------------------------------------

class FilterParseError extends Data.TaggedError("FilterParseError")<{ message: string }> {}

// ---------------------------------------------------------------------------
// Span row parsing
// ---------------------------------------------------------------------------

const SpanAttributeValueSchema = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)
const SpanAttributesSchema = Schema.parseJson(
  Schema.Record({ key: Schema.String, value: SpanAttributeValueSchema })
)
const parseAttributes = Schema.decodeUnknown(SpanAttributesSchema)

type RawSpanRow = {
  seqId: number
  id: string
  name: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  kind: string
  durationMs: number
  status: "ok" | "error"
  error: string | null
  attributes: string
  created: string
}

const parseSpanRow = (raw: RawSpanRow) =>
  parseAttributes(raw.attributes).pipe(
    Effect.orElseSucceed((): Record<string, string | number | boolean> => ({})),
    Effect.map((attributes) => ({
      seqId: raw.seqId,
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
      created: raw.created,
    }))
  )

// ---------------------------------------------------------------------------
// Helper: parse ?filter= query param → FilterNode option
// ---------------------------------------------------------------------------

const FilterNodeFromJson = Schema.parseJson(FilterNodeSchema)

function parseFilterParam(
  url: URL
): Effect.Effect<Option.Option<FilterNode>, FilterParseError> {
  const raw = url.searchParams.get("filter")
  if (raw === null) return Effect.succeed(Option.none())

  return Schema.decodeUnknown(FilterNodeFromJson)(raw).pipe(
    Effect.mapError((e) => new FilterParseError({ message: `filter: ${e.message}` })),
    Effect.map(Option.some)
  )
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function notConfiguredResponse() {
  return HttpServerResponse.unsafeJson({
    logs: [],
    total: 0,
    limit: 0,
    nextCursor: null,
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
  const afterParam = url.searchParams.get("after")
  const afterCursor = afterParam !== null && afterParam !== "" ? Number(afterParam) : null

  // Parse ?filter= and compile against the logs schema.
  // FilterParseError and ValidationError both propagate to the outer pipe.
  const filterNodeOpt = yield* parseFilterParam(url)

  let compiledWhere: { sql: string; params: ReadonlyArray<unknown> } | null = null
  if (Option.isSome(filterNodeOpt)) {
    compiledWhere = yield* filterNodeToWhereClause(filterNodeOpt.value, LogsCollection.schema, "logs")
  }

  type LogRow = {
    id: string
    seqId: number
    level: string
    message: string
    created: string
    traceId: string | null
    spanId: string | null
  }

  const fetchLimit = limit + 1
  let logs: ReadonlyArray<LogRow>

  if (compiledWhere !== null && afterCursor !== null) {
    logs = yield* sql<LogRow>`
      SELECT * FROM ${sql("logs")} t
      WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)} AND t.seqId < ${afterCursor}
      ORDER BY t.seqId DESC
      LIMIT ${fetchLimit}
    `
  } else if (compiledWhere !== null) {
    logs = yield* sql<LogRow>`
      SELECT * FROM ${sql("logs")} t
      WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}
      ORDER BY t.seqId DESC
      LIMIT ${fetchLimit}
    `
  } else if (afterCursor !== null) {
    logs = yield* sql<LogRow>`
      SELECT * FROM ${sql("logs")} t
      WHERE t.seqId < ${afterCursor}
      ORDER BY t.seqId DESC
      LIMIT ${fetchLimit}
    `
  } else {
    logs = yield* sql<LogRow>`
      SELECT * FROM ${sql("logs")} t
      ORDER BY t.seqId DESC
      LIMIT ${fetchLimit}
    `
  }

  const total = yield* (compiledWhere !== null
    ? sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM ${sql("logs")} t WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}`
    : sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM ${sql("logs")} t`)

  const hasMore = logs.length > limit
  const items = hasMore ? logs.slice(0, limit) : logs
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.seqId : null

  return HttpServerResponse.unsafeJson({
    logs: items,
    total: total[0].cnt,
    limit,
    nextCursor,
  })
}).pipe(
  Effect.catchTag("FilterParseError", (e) =>
    Effect.succeed(HttpServerResponse.unsafeJson({ error: e.message }, { status: 400 }))
  ),
  Effect.catchTag("ValidationError", (e) =>
    Effect.succeed(HttpServerResponse.unsafeJson({ error: e.issues.join(", ") }, { status: 400 }))
  )
)

export const telemetrySpansRoute = Effect.gen(function* () {
  const sqlOpt = yield* Effect.serviceOption(TelemetrySqlClient)
  if (Option.isNone(sqlOpt)) {
    return HttpServerResponse.unsafeJson({ spans: [], total: 0, limit: 0, nextCursor: null })
  }
  const sql = sqlOpt.value

  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const limitParam = Number(url.searchParams.get("limit") ?? "50")
  const limit = Math.max(1, Math.min(limitParam, 200))
  const afterParam = url.searchParams.get("after")
  const afterCursor = afterParam !== null && afterParam !== "" ? Number(afterParam) : null
  const traceId = url.searchParams.get("traceId")

  // traceId fast path: return all spans for the given trace, ordered chronologically.
  if (traceId !== null) {
    const rawSpans = yield* sql<RawSpanRow>`
      SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, created
      FROM ${sql("spans")}
      WHERE traceId = ${traceId}
      ORDER BY created ASC
    `
    const spans = yield* Effect.all(rawSpans.map(parseSpanRow), { concurrency: "unbounded" })
    return HttpServerResponse.unsafeJson({ spans, total: spans.length, limit, nextCursor: null })
  }

  // Parse ?filter= and compile against the spans schema.
  const filterNodeOpt = yield* parseFilterParam(url)

  let compiledWhere: { sql: string; params: ReadonlyArray<unknown> } | null = null
  if (Option.isSome(filterNodeOpt)) {
    compiledWhere = yield* filterNodeToWhereClause(filterNodeOpt.value, SpansCollection.schema, "spans")
  }

  const fetchLimit = limit + 1

  if (compiledWhere !== null) {
    // Filtered path: simple SELECT with WHERE clause and pagination.
    const rawSpans = yield* (afterCursor !== null
      ? sql<RawSpanRow>`
          SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, created
          FROM ${sql("spans")} t
          WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)} AND t.seqId < ${afterCursor}
          ORDER BY t.seqId DESC
          LIMIT ${fetchLimit}
        `
      : sql<RawSpanRow>`
          SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, created
          FROM ${sql("spans")} t
          WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}
          ORDER BY t.seqId DESC
          LIMIT ${fetchLimit}
        `)

    const total = yield* sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM ${sql("spans")} t
      WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}
    `

    const hasMore = rawSpans.length > limit
    const items = hasMore ? rawSpans.slice(0, limit) : rawSpans
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.seqId : null
    const spans = yield* Effect.all(items.map(parseSpanRow), { concurrency: "unbounded" })
    return HttpServerResponse.unsafeJson({
      spans,
      total: total[0].cnt,
      limit,
      nextCursor,
    })
  }

  // Unfiltered path: group by traceId so the UI gets distinct root traces.
  const traceRows = yield* (afterCursor !== null
    ? sql<{ traceId: string; maxSeqId: number }>`
        SELECT traceId, MAX(seqId) as maxSeqId
        FROM ${sql("spans")} t
        GROUP BY traceId
        HAVING MAX(seqId) < ${afterCursor}
        ORDER BY maxSeqId DESC
        LIMIT ${fetchLimit}
      `
    : sql<{ traceId: string; maxSeqId: number }>`
        SELECT traceId, MAX(seqId) as maxSeqId
        FROM ${sql("spans")} t
        GROUP BY traceId
        ORDER BY maxSeqId DESC
        LIMIT ${fetchLimit}
      `)

  const total = yield* sql<{ cnt: number }>`SELECT COUNT(DISTINCT traceId) as cnt FROM ${sql("spans")} t`

  const hasMore = traceRows.length > limit
  const pagedTraces = hasMore ? traceRows.slice(0, limit) : traceRows
  const nextCursor = hasMore && pagedTraces.length > 0 ? pagedTraces[pagedTraces.length - 1]!.maxSeqId : null

  if (pagedTraces.length === 0) {
    return HttpServerResponse.unsafeJson({ spans: [], total: total[0].cnt, limit, nextCursor: null })
  }

  const traceIds = pagedTraces.map((r) => r.traceId)
  const rawSpans = yield* sql<RawSpanRow>`
    SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, created
    FROM ${sql("spans")}
    WHERE ${sql.in("traceId", traceIds)}
    ORDER BY created ASC
  `
  const spans = yield* Effect.all(rawSpans.map(parseSpanRow), { concurrency: "unbounded" })

  return HttpServerResponse.unsafeJson({
    spans,
    total: total[0].cnt,
    limit,
    nextCursor,
  })
}).pipe(
  Effect.catchTag("FilterParseError", (e) =>
    Effect.succeed(HttpServerResponse.unsafeJson({ error: e.message }, { status: 400 }))
  ),
  Effect.catchTag("ValidationError", (e) =>
    Effect.succeed(HttpServerResponse.unsafeJson({ error: e.issues.join(", ") }, { status: 400 }))
  )
)
