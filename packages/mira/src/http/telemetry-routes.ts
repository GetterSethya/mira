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

  const logs = yield* (compiledWhere !== null
    ? sql<LogRow>`
        SELECT * FROM ${sql("logs")} t
        WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}
        ORDER BY t.seqId DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : sql<LogRow>`
        SELECT * FROM ${sql("logs")} t
        ORDER BY t.seqId DESC
        LIMIT ${limit} OFFSET ${offset}
      `)

  const total = yield* (compiledWhere !== null
    ? sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM ${sql("logs")} t WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}`
    : sql<{ cnt: number }>`SELECT COUNT(*) as cnt FROM ${sql("logs")} t`)

  return HttpServerResponse.unsafeJson({
    logs,
    total: total[0].cnt,
    limit,
    offset,
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
    return HttpServerResponse.unsafeJson({ spans: [], total: 0, limit: 0, offset: 0 })
  }
  const sql = sqlOpt.value

  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const limitParam = Number(url.searchParams.get("limit") ?? "50")
  const limit = Math.max(1, Math.min(limitParam, 200))
  const offset = Number(url.searchParams.get("offset") ?? "0")
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
    return HttpServerResponse.unsafeJson({ spans, total: spans.length, limit, offset })
  }

  // Parse ?filter= and compile against the spans schema.
  const filterNodeOpt = yield* parseFilterParam(url)

  let compiledWhere: { sql: string; params: ReadonlyArray<unknown> } | null = null
  if (Option.isSome(filterNodeOpt)) {
    compiledWhere = yield* filterNodeToWhereClause(filterNodeOpt.value, SpansCollection.schema, "spans")
  }

  if (compiledWhere !== null) {
    // Filtered path: simple SELECT with WHERE clause and pagination.
    const rawSpans = yield* sql<RawSpanRow>`
      SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, created
      FROM ${sql("spans")} t
      WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}
      ORDER BY created ASC
      LIMIT ${limit} OFFSET ${offset}
    `
    const total = yield* sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM ${sql("spans")} t
      WHERE ${unsafeFragment(compiledWhere.sql, compiledWhere.params)}
    `
    const spans = yield* Effect.all(rawSpans.map(parseSpanRow), { concurrency: "unbounded" })
    return HttpServerResponse.unsafeJson({ spans, total: total[0].cnt, limit, offset })
  }

  // Paginate by trace (effective root spans), then return all child spans for those traces.
  // A span is an effective root if it has no parent, OR its parent spanId doesn't exist in
  // our DB (i.e. the parent is a browser-side span propagated via traceparent but never recorded).
  const rawSpans = yield* sql<RawSpanRow>`
    SELECT id, name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes, created
    FROM ${sql("spans")}
    WHERE traceId IN (
      SELECT traceId FROM ${sql("spans")}
      WHERE parentSpanId IS NULL
         OR parentSpanId NOT IN (SELECT spanId FROM ${sql("spans")})
      ORDER BY created DESC
      LIMIT ${limit} OFFSET ${offset}
    )
    ORDER BY created ASC
  `
  const total = yield* sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt FROM ${sql("spans")}
    WHERE parentSpanId IS NULL
       OR parentSpanId NOT IN (SELECT spanId FROM ${sql("spans")})
  `
  const spans = yield* Effect.all(rawSpans.map(parseSpanRow), { concurrency: "unbounded" })

  return HttpServerResponse.unsafeJson({ spans, total: total[0].cnt, limit, offset })
}).pipe(
  Effect.catchTag("FilterParseError", (e) =>
    Effect.succeed(HttpServerResponse.unsafeJson({ error: e.message }, { status: 400 }))
  ),
  Effect.catchTag("ValidationError", (e) =>
    Effect.succeed(HttpServerResponse.unsafeJson({ error: e.issues.join(", ") }, { status: 400 }))
  )
)
