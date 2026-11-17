import type { AuthCollectionOptions, FilterNode, RuleMap } from "@gettersethya/mira-collection"
import { FilterNodeSchema } from "@gettersethya/mira-collection"
import { Schema } from "effect"
import { HttpClientRequest as HCR } from "effect/http"

import type { ClientHandler, ExecuteFn } from "./handler.js"
import { makeClientHandler } from "./handler.js"

export type ApiFieldSchema = {
  type?: string
  format?: string
  /** JSON Schema default. Only emitted for boolean fields today. */
  default?: unknown
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  "x-kind"?: string
  "x-system"?: boolean
  "x-hidden"?: boolean
  "x-generated"?: boolean
  "x-view-only"?: boolean
  "x-required"?: boolean
  "x-collection"?: string
  "x-field"?: string
  "x-protected"?: boolean
  "x-literal"?: ReadonlyArray<string>
  "x-maxSize"?: number
  "x-mimeTypes"?: ReadonlyArray<string>
}

export type ApiRuleAction = "list" | "view" | "create" | "update" | "delete" | "manage"

/** Display-only verdict for one rule action, computed by the server. */
export type ApiRuleSummary = {
  action: ApiRuleAction
  kind: "deny" | "public" | "expr"
  /** Record fields referenced by the expression; empty for deny/public. */
  fields: Array<string>
}

/** One normalized index from `x-indexes`. */
export type ApiIndexSchema = {
  fields: Array<string>
  unique: boolean
  /** True for indexes Mira injects (the auth email unique index). */
  system?: boolean
}

export type ApiCollectionSchema = {
  name: string
  kind: "base" | "auth" | "view"
  fields: Record<string, ApiFieldSchema>
  required?: Array<string>
  indexes?: Array<ApiIndexSchema>
  auth?: AuthCollectionOptions
  /** Raw `x-rules`, display-only; `null` when no rules are configured. */
  rules?: RuleMap | null
  /** One row per action; missing rules are reported as `deny`. */
  ruleSummary?: Array<ApiRuleSummary>
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
  getSchema(): ClientHandler<Array<ApiCollectionSchema>>
}

const encodeFilter = Schema.encodeSync(Schema.fromJsonString(FilterNodeSchema))

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
        filter: opts?.filter !== undefined ? encodeFilter(opts.filter) : undefined,
      })
      return makeClientHandler(execute(HCR.get(`/api/_telemetry/logs${qs}`)))
    },

    getSpans: (opts) => {
      const qs = buildQueryParams({
        limit: opts?.limit !== undefined ? String(opts.limit) : undefined,
        after: opts?.cursor != null ? String(opts.cursor) : undefined,
        traceId: opts?.traceId,
        filter: opts?.filter !== undefined ? encodeFilter(opts.filter) : undefined,
      })
      return makeClientHandler(execute(HCR.get(`/api/_telemetry/spans${qs}`)))
    },

    getSchema: () => makeClientHandler(execute(HCR.get("/api/_schema"))),
  }
}
