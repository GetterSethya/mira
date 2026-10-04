import { createServer } from "node:http"

import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpServer } from "effect/http"
import * as NetAddress from "effect/net/NetAddress"

import { makePortRetryServerLayer } from "@/http/port-retry.js"
import { HttpServerFactory } from "@/http/server-factory.js"
import { NodeHttpServerFactoryLayer } from "@/http/server-factory-node.js"

const bindEphemeralPort = Effect.callback<{ port: number; close: () => void }>((resume) => {
  const server = createServer()
  server.on("error", (cause) => resume(Effect.die(cause)))
  server.listen(0, () => {
    const address = server.address()
    if (address === null || typeof address === "string") {
      resume(Effect.die("expected an inet address from ephemeral listener"))
      return
    }
    resume(Effect.succeed({ port: address.port, close: () => server.close() }))
  })
})

const releasePort = (port: { close: () => void }) => Effect.sync(() => port.close())

describe("makePortRetryServerLayer", () => {
  it.effect("increments the port when the requested port is already in use", () =>
    Effect.gen(function* () {
      const occupied = yield* Effect.acquireRelease(bindEphemeralPort, releasePort)
      const factory = yield* HttpServerFactory

      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        makePortRetryServerLayer(factory, occupied.port, 5),
        scope,
      )

      const server = Context.get(context, HttpServer.HttpServer)
      const address = server.address
      assert.ok(NetAddress.isInetAddress(address))
      assert.strictEqual(address.port, occupied.port + 1)

      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.provide(NodeHttpServerFactoryLayer)),
  )

  it.effect("fails with ServeError when the port is busy and retrying is disabled", () =>
    Effect.gen(function* () {
      const occupied = yield* Effect.acquireRelease(bindEphemeralPort, releasePort)
      const factory = yield* HttpServerFactory

      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(makePortRetryServerLayer(factory, occupied.port, 1))),
      )

      assert.ok(Exit.isFailure(exit))
    }).pipe(Effect.provide(NodeHttpServerFactoryLayer)),
  )

  it.effect("reports the actual bound port via the callback", () =>
    Effect.gen(function* () {
      const occupied = yield* Effect.acquireRelease(bindEphemeralPort, releasePort)
      const factory = yield* HttpServerFactory
      let reported: number | null = null

      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(
        makePortRetryServerLayer(factory, occupied.port, 5, (port) => {
          reported = port
        }),
        scope,
      )

      assert.strictEqual(reported, occupied.port + 1)
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.provide(NodeHttpServerFactoryLayer)),
  )
})
