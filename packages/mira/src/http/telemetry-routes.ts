import type { FilterNode } from "@gettersethya/mira-client"
import { FilterNodeSchema } from "@gettersethya/mira-client"
import { Data, Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"

import {
  type TelemetryListQuery,
  TelemetryStore
} from "@/telemetry/store.js"

class FilterParseError extends Data.TaggedError("FilterParseError")<{ message: string }> {}

const FilterNodeFromJson = Schema.fromJsonString(FilterNodeSchema)

function parseFilterParam(
  url: URL
): Effect.Effect<Option.Option<FilterNode>, FilterParseError> {
  const raw = url.searchParams.get("filter")
  if (raw === null) return Effect.succeed(Option.none())

  return Schema.decodeUnknownEffect(FilterNodeFromJson)(raw).pipe(
    Effect.mapError((error) => new FilterParseError({ message: `filter: ${error.message}` })),
    Effect.map(Option.some)
  )
}

function notConfiguredResponse() {
  return HttpServerResponse.jsonUnsafe({
    logs: [],
    total: 0,
    limit: 0,
    nextCursor: null,
    error:
      "Telemetry storage is not configured. Use makeTelemetryLayer() and restart the app."
  })
}

const spanDisabledResponse = () =>
  HttpServerResponse.jsonUnsafe({ spans: [], total: 0, limit: 0, nextCursor: null })

const readStore = Effect.gen(function* () {
  const storeOpt = yield* Effect.serviceOption(TelemetryStore)
  if (Option.isNone(storeOpt)) return null
  return storeOpt.value.read
})

const listQuery = (
  limit: number,
  after: number | null,
  filter: FilterNode | null,
  traceId: string | null
): TelemetryListQuery => ({ limit, after, filter, traceId })

export const telemetryLogsRoute = Effect.gen(function* () {
  const read = yield* readStore
  if (read === null) return notConfiguredResponse()

  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const rawLimit = Number(url.searchParams.get("limit") ?? "100")
  const limit = Number.isFinite(rawLimit) ? Math.min(rawLimit, 1000) : 100
  const afterParam = url.searchParams.get("after")
  const after = afterParam !== null && afterParam !== "" ? Number(afterParam) : null

  const filterOpt = yield* parseFilterParam(url)
  const page = yield* read.listLogs(
    listQuery(limit, after, Option.getOrNull(filterOpt), null)
  )

  return HttpServerResponse.jsonUnsafe({
    logs: page.items,
    total: page.total,
    limit,
    nextCursor: page.nextCursor
  })
}).pipe(
  Effect.catchTag("FilterParseError", (error) =>
    Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 }))
  ),
  Effect.catchTag("ValidationError", (error) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({ error: error.issues.join(", ") }, { status: 400 })
    )
  )
)

export const telemetrySpansRoute = Effect.gen(function* () {
  const read = yield* readStore
  if (read === null) return spanDisabledResponse()

  const req = yield* HttpServerRequest.HttpServerRequest
  const url = new URL(req.url, "http://localhost")

  const rawLimit = Number(url.searchParams.get("limit") ?? "50")
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 200))
  const afterParam = url.searchParams.get("after")
  const after = afterParam !== null && afterParam !== "" ? Number(afterParam) : null
  const traceId = url.searchParams.get("traceId")

  if (traceId !== null) {
    const page = yield* read.listSpans(listQuery(limit, null, null, traceId))
    return HttpServerResponse.jsonUnsafe({
      spans: page.items,
      total: page.total,
      limit,
      nextCursor: page.nextCursor
    })
  }

  const filterOpt = yield* parseFilterParam(url)
  const page = yield* read.listSpans(
    listQuery(limit, after, Option.getOrNull(filterOpt), null)
  )

  return HttpServerResponse.jsonUnsafe({
    spans: page.items,
    total: page.total,
    limit,
    nextCursor: page.nextCursor
  })
}).pipe(
  Effect.catchTag("FilterParseError", (error) =>
    Effect.succeed(HttpServerResponse.jsonUnsafe({ error: error.message }, { status: 400 }))
  ),
  Effect.catchTag("ValidationError", (error) =>
    Effect.succeed(
      HttpServerResponse.jsonUnsafe({ error: error.issues.join(", ") }, { status: 400 })
    )
  )
)
