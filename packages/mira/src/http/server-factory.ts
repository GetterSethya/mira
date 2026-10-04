import { Context } from "effect"
import type { Etag, HttpPlatform, HttpServer } from "effect/http"
import type { ServeError } from "effect/http/HttpServerError"
import type { Layer } from "effect/Layer"

export class HttpServerFactory extends Context.Service<
  HttpServerFactory,
  {
    makeLayer(port: number): Layer<HttpServer.HttpServer | HttpPlatform.HttpPlatform | Etag.Generator, ServeError>
  }
>()("HttpServerFactory") {}
