import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { CronService, CronNotFoundError } from "@gettersethya/mira"
import { requireDashboardAuth } from "./auth.js"

export const cronsRoute = Effect.gen(function* () {
  yield* requireDashboardAuth

  const cronService = yield* CronService
  const states = yield* cronService.getAll()

  return HttpServerResponse.unsafeJson(
    states.map((s) => ({
      name: s.name,
      status: s.status,
      lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
      lastStatus: s.lastStatus ?? null,
      lastDurationMs: s.lastDurationMs ?? null,
      lastError: s.lastError !== undefined ? String(s.lastError) : null
    }))
  )
})

export const cronRunNowRoute = Effect.flatMap(HttpRouter.RouteContext, (routeCtx) =>
  Effect.gen(function* () {
    yield* requireDashboardAuth

    const name = routeCtx.params["name"] ?? ""

    const cronService = yield* CronService

    return yield* cronService.runNow(name).pipe(
      Effect.as(HttpServerResponse.empty({ status: 204 })),
      Effect.catchTag("CronNotFoundError", (_: CronNotFoundError) =>
        Effect.succeed(HttpServerResponse.unsafeJson({ error: "not_found" }, { status: 404 }))
      )
    )
  })
)
