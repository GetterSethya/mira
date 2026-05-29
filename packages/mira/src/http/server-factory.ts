import type { Etag, HttpPlatform, HttpServer } from "@effect/platform"
import type { ServeError } from "@effect/platform/HttpServerError"
import { Context } from "effect"
import type { Layer } from "effect/Layer"

export class HttpServerFactory extends Context.Tag("HttpServerFactory")<
  HttpServerFactory,
  {
    makeLayer(port: number): Layer<HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator, ServeError>
  }
>() {}
