import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"
import { Layer } from "effect"
import { HttpServerFactory } from "./server-factory.js"

export const NodeHttpServerFactoryLayer = Layer.succeed(
  HttpServerFactory,
  HttpServerFactory.of({
    makeLayer: (port) => NodeHttpServer.layer(() => createServer(), { port })
  })
)
