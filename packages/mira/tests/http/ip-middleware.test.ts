import { HttpClient, HttpClientRequest, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Chunk, Effect, Layer, Queue } from "effect"
import { randomBytes } from "node:crypto"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import type { CompletedSpan } from "@/telemetry/tracer.js"
import { makeConsoleTracer } from "@/telemetry/tracer.js"
import { ipAnnotationMiddleware } from "@/http/ip-middleware.js"

const testApp = ipAnnotationMiddleware(Effect.succeed(HttpServerResponse.text("ok")))

function makeIpTestLayer(queue: Queue.Queue<CompletedSpan>) {
  return Layer.mergeAll(
    NodeHttpServer.layerTest,
    Layer.setTracer(makeConsoleTracer(queue, (size) => randomBytes(size))),
  )
}

function findSpanWithIp(spans: ReadonlyArray<CompletedSpan>): CompletedSpan | undefined {
  return spans.find((s) => "http.client_ip" in s.attributes)
}

describe("ipAnnotationMiddleware", () => {
  it.scoped("x-forwarded-for — single IP annotates span", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* testApp.pipe(HttpServer.serveEffect())
        yield* HttpClientRequest.get("/").pipe(
          HttpClientRequest.setHeader("x-forwarded-for", "1.2.3.4"),
          HttpClient.execute,
        )
      }).pipe(Effect.provide(makeIpTestLayer(queue)))
      const spans = Chunk.toArray(yield* Queue.takeAll(queue))
      const span = findSpanWithIp(spans)
      expect(span?.attributes["http.client_ip"]).toBe("1.2.3.4")
    })
  )

  it.scoped("x-forwarded-for — multiple IPs uses first entry", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* testApp.pipe(HttpServer.serveEffect())
        yield* HttpClientRequest.get("/").pipe(
          HttpClientRequest.setHeader("x-forwarded-for", "1.2.3.4, 5.6.7.8, 9.0.0.1"),
          HttpClient.execute,
        )
      }).pipe(Effect.provide(makeIpTestLayer(queue)))
      const spans = Chunk.toArray(yield* Queue.takeAll(queue))
      const span = findSpanWithIp(spans)
      expect(span?.attributes["http.client_ip"]).toBe("1.2.3.4")
    })
  )

  it.scoped("x-real-ip fallback when no x-forwarded-for", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* testApp.pipe(HttpServer.serveEffect())
        yield* HttpClientRequest.get("/").pipe(
          HttpClientRequest.setHeader("x-real-ip", "2.3.4.5"),
          HttpClient.execute,
        )
      }).pipe(Effect.provide(makeIpTestLayer(queue)))
      const spans = Chunk.toArray(yield* Queue.takeAll(queue))
      const span = findSpanWithIp(spans)
      expect(span?.attributes["http.client_ip"]).toBe("2.3.4.5")
    })
  )

  it.scoped("no IP headers — http.client_ip attribute absent", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.gen(function* () {
        yield* testApp.pipe(HttpServer.serveEffect())
        yield* HttpClient.get("/")
      }).pipe(Effect.provide(makeIpTestLayer(queue)))
      const spans = Chunk.toArray(yield* Queue.takeAll(queue))
      const span = findSpanWithIp(spans)
      expect(span).toBeUndefined()
    })
  )
})
