import { FetchHttpClient, Headers, HttpClient, HttpClientRequest as HCR } from "effect/http"
import type { HttpBodyError } from "effect/http/HttpBody"
import { Data, Effect, Exit, Cause, Option } from "effect"
import type {
  ApiCollectionSchema,
  ApiFieldSchema,
  LogsResponse,
  SpanRow,
  SpansResponse
} from "@gettersethya/mira-client"

const BASE = "/_dashboard/api"

export class DashboardApiError extends Data.TaggedError("DashboardApiError")<{
  status: number
  body: unknown
  retryAfterSeconds?: number
}> {}

type DashboardEffect<T> = Effect.Effect<T, DashboardApiError, HttpClient.HttpClient>

const retryAfterFrom = (body: unknown, headers: Headers.Headers): number | undefined => {
  if (typeof body === "object" && body !== null && "retryAfterSeconds" in body) {
    const value = Number((body as { readonly retryAfterSeconds?: unknown }).retryAfterSeconds)
    if (Number.isFinite(value) && value > 0) return value
  }
  const header = Headers.get(headers, "retry-after")
  if (Option.isSome(header)) {
    const value = Number(header.value)
    if (Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

function execute<T>(req: HCR.HttpClientRequest): DashboardEffect<T> {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const finalReq = HCR.prependUrl(BASE)(req)
    const res = yield* http.execute(finalReq)

    if (res.status >= 400) {
      const body = yield* res.json
      const retryAfterSeconds = retryAfterFrom(body, res.headers)
      return yield* new DashboardApiError({
        status: res.status,
        body,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
      })
    }

    if (res.status === 204) {
      return undefined as T
    }

    return (yield* res.json) as T
  }).pipe(
    Effect.catchTag("HttpClientError", (e) =>
      Effect.fail(new DashboardApiError({ status: e.response?.status ?? 0, body: e.message }))
    )
  )
}

function executeWithBody<T>(reqEffect: Effect.Effect<HCR.HttpClientRequest, HttpBodyError, never>): DashboardEffect<T> {
  return reqEffect.pipe(
    Effect.flatMap((req) => execute<T>(req)),
    Effect.catchTag("HttpBodyError", (e) => Effect.fail(new DashboardApiError({ status: 500, body: String(e) })))
  )
}

export async function run<T>(effect: DashboardEffect<T>) {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(FetchHttpClient.layer)))
  if (Exit.isSuccess(exit)) return exit.value
  return Promise.reject(Option.getOrElse(Cause.findErrorOption(exit.cause), () => Cause.squash(exit.cause)))
}

export interface CronApiState {
  name: string
  description: string | null
  status: "standby" | "running"
  lastRunAt: string | null
  lastStatus: "success" | "error" | null
  lastDurationMs: number | null
  lastError: string | null
}

/** Non-secret description of the live file-storage backend. */
export type StorageDescription =
  | { kind: "local"; directory: string }
  | {
      kind: "s3"
      endpoint: string
      bucketName: string
      regionName: string
      forcePathStyle: boolean
      publicBaseUrl: string | null
    }

/** Non-secret description of the live email transport. */
export interface EmailDescription {
  enabled: boolean
  transport: "smtp" | "none"
  host: string | null
  port: number | null
  secure: boolean
  requireTLS: boolean
  from: string | null
  replyTo: string | null
  hasAuth: boolean
  passwordResetUrl: string | null
  emailChangeUrl: string | null
}

export interface AppConfigResponse {
  /** Resolved at boot — may differ from `values.application_url` if the port was taken. */
  appName: string
  applicationUrl: string
  port: number
  /** Persisted `_config` values, minus internal keys. */
  values: Record<string, string>
  editable: string[]
  readOnly: string[]
  secret: string[]
  /** `null` when the storage layer does not implement `describe()`. */
  storage: StorageDescription | null
  email: EmailDescription
}

/** Actions a collection rule map can carry. `manage` is auth-collections-only. */
export type RuleAction = "list" | "view" | "create" | "update" | "delete" | "manage"

/**
 * Display-only mirror of `x-rules`. The dashboard never evaluates these
 * expressions; each action's value is kept as `unknown` so inspection helpers
 * can narrow it with runtime guards instead of trusting the payload.
 */
export type RuleMap = Partial<Record<RuleAction, unknown>>

/** One server-computed rule verdict row from `/api/_schema`. */
export interface SchemaRuleSummary {
  action: RuleAction
  kind: "deny" | "public" | "expr"
  fields: string[]
}

/** One physical or view index from `/api/_schema` (`x-indexes`). */
export interface SchemaIndex {
  fields: string[]
  unique: boolean
  /** True for indexes Mira injects itself (e.g. the auth `email` index). */
  system?: boolean
}

export type EmailTemplateId =
  | "verification"
  | "loginOtp"
  | "passwordless"
  | "passwordReset"
  | "emailChange"
  | "loginAlert"

export type EmailTemplateSource = "builtin" | "global" | "collection"

/** One effective email template rendered with sentinel inputs. */
export interface EmailTemplatePreview {
  id: EmailTemplateId
  label: string
  source: EmailTemplateSource
  subject: string
  text: string
  html: string | null
}

export interface EmailTemplatesResponse {
  collection: string
  transportEnabled: boolean
  templates: EmailTemplatePreview[]
}

export const dashboardApi = {
  bootstrapStatus: (): DashboardEffect<{ bootstrapped: boolean }> => execute(HCR.get("/bootstrap-status")),

  register: (
    email: string,
    password: string,
    name: string,
    token: string
  ): DashboardEffect<{ id: string; email: string }> =>
    executeWithBody(HCR.bodyJson(HCR.post("/register"), { email, password, name, token })),

  config: (): DashboardEffect<AppConfigResponse> => execute(HCR.get("/config")),

  updateConfig: (values: Record<string, string>): DashboardEffect<AppConfigResponse> =>
    executeWithBody(HCR.bodyJson(HCR.put("/config"), { values })),

  emailTest: (to?: string): DashboardEffect<{ ok: true }> =>
    executeWithBody(HCR.bodyJson(HCR.post("/email/test"), to === undefined ? {} : { to })),

  emailTemplates: (collection: string): DashboardEffect<EmailTemplatesResponse> =>
    execute(HCR.get(`/email/templates?collection=${encodeURIComponent(collection)}`)),

  crons: {
    getAll: (): DashboardEffect<CronApiState[]> => execute(HCR.get("/crons")),
    runNow: (name: string): DashboardEffect<void> => execute(HCR.post(`/crons/${name}/run`))
  }
}

/**
 * The dashboard's view of a collection schema. `rules` and `indexes` stay
 * loosely typed because `ApiCollectionSchema` predates the inspection payload;
 * `schema-inspection.ts` narrows them at runtime and exposes typed rows.
 */
export type CollectionSchema = ApiCollectionSchema & {
  ruleSummary?: SchemaRuleSummary[]
}
export type FieldSchema = ApiFieldSchema
export type { LogsResponse, SpanRow, SpansResponse }
