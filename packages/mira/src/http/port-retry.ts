import type { Context } from "effect"
import { Effect, Exit, Layer, Scope } from "effect"
import type { Etag, HttpPlatform, HttpServer } from "effect/http"
import type { ServeError } from "effect/http/HttpServerError"

import type { HttpServerFactory } from "./server-factory.js"

const DEFAULT_MAX_ATTEMPTS = 10

const isAddressInUse = (error: ServeError): boolean => {
  const cause: unknown = error.cause
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EADDRINUSE"
  )
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
            Effect.catchTag("ServeError", (error) =>
              Effect.gen(function* () {
                yield* Scope.close(scope, Exit.fail(error))
                if (isAddressInUse(error) && remaining > 0) {
                  yield* Effect.logWarning(
                    `Port ${candidate} is already in use — trying port ${candidate + 1}...`
                  )
                  return yield* attempt(candidate + 1, remaining - 1)
                }
                return yield* Effect.fail(error)
              })
            )
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
