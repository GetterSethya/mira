import type { FilterNode } from "@gettersethya/mira-collection"

const BASE = "/_dashboard/api"
const API_BASE = "/api"

type RequestInit2 = {
  method?: string
  body?: BodyInit
  headers?: Record<string, string>
}

async function request<T>(path: string, init: RequestInit2 = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers }
  if (init.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json"
  }

  const res = await fetch(path, { method: init.method ?? "GET", headers, body: init.body })
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    throw Object.assign(new Error("Request failed"), { status: res.status, body })
  }
  if (res.status === 204) return undefined as unknown as T
  return res.json() as Promise<T>
}

export type LogsResponse = {
  logs: { id: string; level: string; message: string; created: string; traceId: string | null; spanId: string | null }[]
  total: number
  limit: number
  offset: number
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

export type SpansResponse = {
  spans: SpanRow[]
  total: number
  limit: number
  offset: number
}

export type SuperadminRow = { id: string; email: string; created: string }

export const client = {
  bootstrapStatus: () => request<{ bootstrapped: boolean }>(`${BASE}/bootstrap-status`),

  login: (email: string, password: string) =>
    request<{ token: string; record: Record<string, unknown> }>(`${API_BASE}/collections/_superadmin/auth-with-password`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    request<void>(`${API_BASE}/auth/logout`, { method: "POST" }),

  me: () =>
    request<{ collection: string; record: Record<string, unknown> }>(`${API_BASE}/auth/me`),

  register: (email: string, password: string, token: string) =>
    request<{ id: string; email: string }>(`${BASE}/register`, {
      method: "POST",
      body: JSON.stringify({ email, password, token }),
    }),

  schema: () => request<CollectionSchema[]>(`${API_BASE}/_schema`),

  logs: (params: { limit?: number; offset?: number; filter?: FilterNode }) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set("limit", String(params.limit))
    if (params.offset !== undefined) q.set("offset", String(params.offset))
    if (params.filter !== undefined) q.set("filter", JSON.stringify(params.filter))
    return request<LogsResponse>(`${API_BASE}/_telemetry/logs?${q}`)
  },

  spans: (params: { limit?: number; offset?: number; traceId?: string }) => {
    const q = new URLSearchParams()
    if (params.limit !== undefined) q.set("limit", String(params.limit))
    if (params.offset !== undefined) q.set("offset", String(params.offset))
    if (params.traceId) q.set("traceId", params.traceId)
    return request<SpansResponse>(`${API_BASE}/_telemetry/spans?${q}`)
  },

  config: () => request<{ config: Record<string, unknown>; keys: string[] }>(`${BASE}/config`),

  superadmins: {
    list: () => request<{ items: SuperadminRow[] }>(`${BASE}/superadmin`),
    create: (email: string, password: string) =>
      request<{ id: string; email: string }>(`${BASE}/superadmin/create`, {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    delete: (id: string) => request<void>(`${BASE}/superadmin/${id}`, { method: "DELETE" }),
  },
}

export type CollectionSchema = {
  name: string
  kind: "base" | "auth" | "view"
  fields: Record<string, FieldSchema>
  required?: string[]
  indexes?: unknown[]
  rules?: unknown
  viewQuery?: string
}

export type FieldSchema = {
  type?: string
  format?: string
  "x-kind"?: string
  "x-system"?: boolean
  "x-hidden"?: boolean
  "x-required"?: boolean
  "x-relation"?: string
  "x-protected"?: boolean
}
