import type { Context } from "effect"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import type { Etag, HttpPlatform, HttpServer } from "effect/http"
import { ServeError } from "effect/http/HttpServerError"

import type { HttpServerFactory } from "./server-factory.js"

const DEFAULT_MAX_ATTEMPTS = 10

const isAddressInUseValue = (value: unknown, depth = 0): boolean => {
  if (depth > 4 || typeof value !== "object" || value === null) return false
  const record = value as { readonly code?: unknown; readonly message?: unknown; readonly cause?: unknown }
  if (record.code === "EADDRINUSE") return true
  if (typeof record.message === "string" && record.message.includes("EADDRINUSE")) return true
  if (record.cause !== undefined && record.cause !== value) {
    return isAddressInUseValue(record.cause, depth + 1)
  }
  return false
}

/**
 * Bun.serve throws a synchronous bind error as a defect rather than failing
 * with a typed `ServeError`. Normalize both shapes so port retry works on Node
 * and Bun.
 */
const serveErrorFromCause = (cause: Cause.Cause<unknown>): ServeError | null => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      const error: unknown = reason.error
      const isServeError =
        error instanceof ServeError ||
        (typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          (error as { readonly _tag?: unknown })._tag === "ServeError")
      if (isServeError && isAddressInUseValue((error as ServeError).cause)) {
        return error as ServeError
      }
    }
    if (Cause.isDieReason(reason) && isAddressInUseValue(reason.defect)) {
      return new ServeError({ cause: reason.defect })
    }
  }
  return null
}

/**
 * Builds the HTTP server layer starting at `port`. When the bind fails because
 * the address is already in use, the port is incremented and the bind is
 * retried, up to `maxAttempts` ports in total. Any other `ServeError` fails
 * immediately. The starting port is always attempted first.
 *
 * @param factory - The platform's `HttpServerFactory` service
 * @param port - The first port to try
 * @param maxAttempts - Total number of ports to try (default 10)
 * @param onBoundPort - Called with the port the server actually bound to
 */
export const makePortRetryServerLayer = (
  factory: Context.Service.Shape<typeof HttpServerFactory>,
  port: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  onBoundPort?: (port: number) => void
): Layer.Layer<HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator, ServeError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const outerScope = yield* Effect.scope

      type ServerContext = Context.Context<HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator>

      const attempt = (
        candidate: number,
        remaining: number
      ): Effect.Effect<readonly [number, ServerContext], ServeError> =>
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          return yield* Layer.buildWithScope(factory.makeLayer(candidate), scope).pipe(
            Effect.tap(() => Scope.addFinalizer(outerScope, Scope.close(scope, Exit.void))),
            Effect.map((context): readonly [number, ServerContext] => [candidate, context]),
            Effect.catchCause((cause) => {
              const error = serveErrorFromCause(cause)
              if (error === null) {
                return Effect.failCause(cause)
              }
              return Effect.gen(function* () {
                yield* Scope.close(scope, Exit.fail(error))
                if (isAddressInUseValue(error.cause) && remaining > 0) {
                  yield* Effect.logWarning(
                    `Port ${candidate} is already in use — trying port ${candidate + 1}...`
                  )
                  return yield* attempt(candidate + 1, remaining - 1)
                }
                return yield* Effect.fail(error)
              })
            })
          )
        })

      const [boundPort, context] = yield* attempt(port, Math.max(maxAttempts - 1, 0))
      if (boundPort !== port) {
        yield* Effect.logInfo(`Port ${port} was busy — listening on port ${boundPort} instead.`)
      }
      if (onBoundPort !== undefined) {
        yield* Effect.sync(() => onBoundPort(boundPort))
      }
      return Layer.succeedContext(context)
    })
  )
