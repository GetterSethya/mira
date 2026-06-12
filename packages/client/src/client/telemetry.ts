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
  "x-required"?: boolean
  "x-relation"?: string
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
  level: string
  message: string
  created: string
  traceId: string | null
  spanId: string | null
}

export type SpanRow = {
  id: string
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
  offset: number
}

export type SpansResponse = {
  spans: Array<SpanRow>
  total: number
  limit: number
  offset: number
}

export type TelemetryClient = {
  getLogs(opts?: {
    limit?: number
    offset?: number
    filter?: FilterNode
  }): ClientHandler<LogsResponse>

  getSpans(opts?: {
    limit?: number
    offset?: number
    traceId?: string
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
        offset: opts?.offset !== undefined ? String(opts.offset) : undefined,
        filter: opts?.filter !== undefined ? JSON.stringify(opts.filter) : undefined,
      })
      return makeClientHandler(execute<LogsResponse>(HCR.get(`/api/_telemetry/logs${qs}`)))
    },

    getSpans: (opts) => {
      const qs = buildQueryParams({
        limit: opts?.limit !== undefined ? String(opts.limit) : undefined,
        offset: opts?.offset !== undefined ? String(opts.offset) : undefined,
        traceId: opts?.traceId,
      })
      return makeClientHandler(execute<SpansResponse>(HCR.get(`/api/_telemetry/spans${qs}`)))
    },

    getSchema: () => makeClientHandler(execute<ApiCollectionSchema[]>(HCR.get("/api/_schema"))),
  }
}
