import { Data, Effect, Redacted } from "effect"
import { HttpServerRequest } from "@effect/platform"
import { AppConfig, verifyJwt } from "@gettersethya/mira"

export class DashboardUnauthorizedError extends Data.TaggedError("DashboardUnauthorizedError")<{}> {}

function extractToken(req: HttpServerRequest.HttpServerRequest): string | null {
  const auth = req.headers["authorization"]
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m !== null) return m[1]
  }
  return req.cookies["mira_token"] ?? null
}

export const requireDashboardAuth = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const token = extractToken(req)
  if (token === null) {
    return yield* new DashboardUnauthorizedError()
  }
  const config = yield* AppConfig
  const payload = yield* verifyJwt(token, Redacted.value(config.jwtSecret)).pipe(
    Effect.catchAll(() => new DashboardUnauthorizedError())
  )
  if (payload.col !== "_superadmin") {
    return yield* new DashboardUnauthorizedError()
  }
  return payload
})
