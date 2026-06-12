import { FetchHttpClient, HttpClient, HttpClientRequest as HCR } from "@effect/platform"
import type { HttpBodyError } from "@effect/platform/HttpBody"
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
}> {}

type DashboardEffect<T> = Effect.Effect<T, DashboardApiError, HttpClient.HttpClient>

function execute<T>(req: HCR.HttpClientRequest): DashboardEffect<T> {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const finalReq = HCR.prependUrl(BASE)(req)
    const res = yield* http.execute(finalReq)

    if (res.status >= 400) {
      const body = yield* res.json
      return yield* new DashboardApiError({ status: res.status, body })
    }

    if (res.status === 204) {
      return undefined as T
    }

    return (yield* res.json) as T
  }).pipe(
    Effect.catchTags({
      RequestError: (e) => Effect.fail(new DashboardApiError({ status: 0, body: e.message })),
      ResponseError: (e) => Effect.fail(new DashboardApiError({ status: e.response.status, body: e.message }))
    })
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
  return Promise.reject(Option.getOrElse(Cause.failureOption(exit.cause), () => Cause.squash(exit.cause)))
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

  config: (): DashboardEffect<{ config: Record<string, unknown>; keys: string[] }> => execute(HCR.get("/config"))
}

export type CollectionSchema = ApiCollectionSchema
export type FieldSchema = ApiFieldSchema
export type { LogsResponse, SpanRow, SpansResponse }
