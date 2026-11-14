import { Data, Effect, Tracer } from "effect"
import { HttpServerRequest } from "effect/http"
import { authenticateSession } from "@gettersethya/mira"

export class DashboardUnauthorizedError extends Data.TaggedError("DashboardUnauthorizedError")<{}> {}

function extractToken(req: HttpServerRequest.HttpServerRequest): string | null {
  const auth = req.headers["authorization"]
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m !== null) return m[1]
  }
  return req.cookies["mira_token"] ?? null
}

const annotateCurrentSpan = (key: string, value: string) =>
  Effect.currentSpan.pipe(
    Effect.tap((span: Tracer.Span) => Effect.sync(() => span.attribute(key, value))),
    Effect.ignore
  )

export const requireDashboardAuth = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const token = extractToken(req)

  if (token === null) {
    yield* annotateCurrentSpan("auth.result", "anonymous")
    return yield* new DashboardUnauthorizedError()
  }

  const session = yield* authenticateSession(token, (name) => name === "_superadmin")
  if (session === undefined) {
    yield* annotateCurrentSpan("auth.result", "invalid_token")
    return yield* new DashboardUnauthorizedError()
  }

  yield* annotateCurrentSpan("auth.result", "authenticated")
  yield* annotateCurrentSpan("auth.collection", "_superadmin")

  const id = session.record["id"]
  return {
    col: session.collection,
    sub: typeof id === "string" ? id : "",
    record: session.record
  }
}).pipe(Effect.withSpan("http.auth", { kind: "internal" }))
