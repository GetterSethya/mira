import { HttpClientRequest as HCR } from "@effect/platform"
import type { FilterNode } from "@gettersethya/mira-collection"
import type { ClientHandler, ExecuteFn } from "./handler.js"
import { makeClientHandler } from "./handler.js"

export type ApiFieldSchema = {
  type?: string
  format?: string
  "x-kind"?: string
  "x-system"?: boolean
  "x-hidden"?: boolean
  "x-generated"?: boolean
  "x-view-only"?: boolean
  "x-required"?: boolean
  "x-collection"?: string
  "x-field"?: string
  "x-protected"?: boolean
}

export type ApiCollectionSchema = {
  name: string
  kind: "base" | "auth" | "view"
  fields: Record<string, ApiFieldSchema>
  required?: string[]
  indexes?: unknown[]
  rules?: unknown
  viewQuery?: string
}

type LogEntry = {
  id: string
  seqId: number
  level: string
  message: string
  created: string
  traceId: string | null
  spanId: string | null
}

export type SpanRow = {
  id: string
  seqId?: number
  name: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  kind: string
  durationMs: number
  status: "ok" | "error"
  error: string | null
  attributes: Record<string, string | number | boolean>
  created: string
}

export type LogsResponse = {
  logs: Array<LogEntry>
  total: number
  limit: number
  nextCursor: number | null
}

export type SpansResponse = {
  spans: Array<SpanRow>
  total: number
  limit: number
  nextCursor: number | null
}

export type TelemetryClient = {
  getLogs(opts?: {
    limit?: number
    cursor?: number | null
    filter?: FilterNode
  }): ClientHandler<LogsResponse>

  getSpans(opts?: {
    limit?: number
    cursor?: number | null
    traceId?: string
    filter?: FilterNode
  }): ClientHandler<SpansResponse>

  /**
   * Fetches all registered collection schemas from `GET /api/_schema`.
   * Returns an array of `CollectionSchema` objects describing each collection's
   * fields, kind, indexes, rules, and (for view collections) the SQL view query.
   */
  getSchema(): ClientHandler<ApiCollectionSchema[]>
}

function buildQueryParams(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, v)
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ""
}

export function makeTelemetryClient(execute: ExecuteFn): TelemetryClient {
  return {
    getLogs: (opts) => {
      const qs = buildQueryParams({
        limit: opts?.limit !== undefined ? String(opts.limit) : undefined,
        after: opts?.cursor != null ? String(opts.cursor) : undefined,
        filter: opts?.filter !== undefined ? JSON.stringify(opts.filter) : undefined,
      })
      return makeClientHandler(execute(HCR.get(`/_telemetry/logs${qs}`)))
    },

    getSpans: (opts) => {
      const qs = buildQueryParams({
        limit: opts?.limit !== undefined ? String(opts.limit) : undefined,
        after: opts?.cursor != null ? String(opts.cursor) : undefined,
        traceId: opts?.traceId,
        filter: opts?.filter !== undefined ? JSON.stringify(opts.filter) : undefined,
      })
      return makeClientHandler(execute(HCR.get(`/_telemetry/spans${qs}`)))
    },

    getSchema: () => makeClientHandler(execute(HCR.get("/api/_schema"))),
  }
}
