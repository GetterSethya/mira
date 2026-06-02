import { HttpClientRequest as HCR } from "@effect/platform"
import type { ClientHandler, ExecuteFn } from "./handler.js"
import { makeClientHandler } from "./handler.js"

type LogEntry = {
  id: number
  level: string
  message: string
  timestamp: string
  traceId: string | null
  spanId: string | null
}

type SpanEntry = {
  id: number
  name: string
  traceId: string
  spanId: string
  parentSpanId: string | null
  kind: string
  durationMs: number
  status: "ok" | "error"
  error: string | null
  attributes: Record<string, string | number | boolean>
  timestamp: string
}

type LogsResponse = {
  logs: Array<LogEntry>
  total: number
  limit: number
  offset: number
}

type SpansResponse = {
  spans: Array<SpanEntry>
  total: number
  limit: number
  offset: number
}

export type TelemetryClient = {
  getLogs(opts?: {
    limit?: number
    offset?: number
    level?: string
  }): ClientHandler<LogsResponse>

  getSpans(opts?: {
    limit?: number
    offset?: number
    traceId?: string
  }): ClientHandler<SpansResponse>
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
        level: opts?.level,
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
  }
}
