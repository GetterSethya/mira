import { Headers, HttpApp, HttpServerRequest } from "@effect/platform"
import { Effect, Option } from "effect"

function extractClientIp(headers: Headers.Headers) {
  const forwarded = Headers.get(headers, "x-forwarded-for")
  if (Option.isSome(forwarded)) {
    const first = forwarded.value.split(",")[0].trim()
    if (first.length > 0) return first
  }
  const realIp = Headers.get(headers, "x-real-ip")
  return Option.isSome(realIp) ? realIp.value.trim() : undefined
}

export const ipAnnotationMiddleware = <E, R>(app: HttpApp.Default<E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const ip = extractClientIp(request.headers)
    yield* Effect.currentSpan.pipe(
      Effect.tap((span) =>
        Effect.sync(() => {
          span.attribute("auth.collection", "")
          if (ip !== undefined) {
            span.attribute("http.client_ip", ip ?? "")
          }
        })
      ),
      Effect.ignore
    )
    return yield* app
  })
