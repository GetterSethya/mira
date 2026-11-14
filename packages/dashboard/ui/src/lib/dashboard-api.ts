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

  crons: {
    getAll: (): DashboardEffect<CronApiState[]> => execute(HCR.get("/crons")),
    runNow: (name: string): DashboardEffect<void> => execute(HCR.post(`/crons/${name}/run`))
  }
}

export type CollectionSchema = ApiCollectionSchema
export type FieldSchema = ApiFieldSchema
export type { LogsResponse, SpanRow, SpansResponse }
