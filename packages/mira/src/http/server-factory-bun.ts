import { BunHttpServer } from "@effect/platform-bun"
import { Layer } from "effect"

import { HttpServerFactory } from "./server-factory.js"

/**
 * Bun implementation of `HttpServerFactory`. `BunHttpServer.layer` binds a
 * `Bun.serve` server and provides the Bun HTTP platform services.
 */
export const BunHttpServerFactoryLayer = Layer.succeed(
  HttpServerFactory,
  HttpServerFactory.of({
    makeLayer: (port) => BunHttpServer.layer({ port })
  })
)
