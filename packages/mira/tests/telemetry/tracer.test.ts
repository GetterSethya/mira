import { randomBytes } from "node:crypto"

import { describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Queue, Tracer } from "effect"
import { expect } from "vitest"

import type { CompletedSpan } from "@/telemetry/tracer.js"
import { formatPrettySpan, makeConsoleTracer } from "@/telemetry/tracer.js"

function tracerLayer(queue: Queue.Queue<CompletedSpan>): Layer.Layer<never> {
  return Layer.succeed(Tracer.Tracer, makeConsoleTracer(queue, (size) => randomBytes(size)))
}

describe("makeConsoleTracer", () => {
  it.effect("span emitted on success", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.succeed(42).pipe(
        Effect.withSpan("test.op"),
        Effect.provide(tracerLayer(queue))
      )
      const span = yield* Queue.take(queue)
      expect(span.name).toBe("test.op")
      expect(span.status).toBe("ok")
      expect(span.parentSpanId).toBeUndefined()
      expect(span.durationMs).toBeGreaterThanOrEqual(0)
    })
  )

  it.effect("span emitted on failure", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.fail("oops").pipe(
        Effect.withSpan("test.op"),
        Effect.ignore,
        Effect.provide(tracerLayer(queue))
      )
      const span = yield* Queue.take(queue)
      expect(span.status).toBe("error")
      expect(span.error).toBeDefined()
      expect(span.error?.length).toBeGreaterThan(0)
    })
  )

  it.effect("nested spans share traceId and parent link", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.succeed(1).pipe(
        Effect.withSpan("inner"),
        Effect.withSpan("outer"),
        Effect.provide(tracerLayer(queue))
      )
      const all = (yield* Queue.clear(queue))
      const inner = all.find((s) => s.name === "inner")
      const outer = all.find((s) => s.name === "outer")
      expect(inner).toBeDefined()
      expect(outer).toBeDefined()
      expect(inner!.traceId).toBe(outer!.traceId)
      expect(inner!.parentSpanId).toBe(outer!.spanId)
    })
  )

  it.effect("root span has no parentSpanId", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.succeed(1).pipe(
        Effect.withSpan("root"),
        Effect.provide(tracerLayer(queue))
      )
      const span = yield* Queue.take(queue)
      expect(span.parentSpanId).toBeUndefined()
    })
  )

  it.effect("attributes are captured", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.succeed(1).pipe(
        Effect.withSpan("op", { attributes: { table: "posts" } }),
        Effect.provide(tracerLayer(queue))
      )
      const span = yield* Queue.take(queue)
      expect(span.attributes["table"]).toBe("posts")
    })
  )

  it.effect("kind is captured", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.succeed(1).pipe(
        Effect.withSpan("op", { kind: "client" }),
        Effect.provide(tracerLayer(queue))
      )
      const span = yield* Queue.take(queue)
      expect(span.kind).toBe("client")
    })
  )

  it.effect("span end is called synchronously — unsafeOffer ran before fiber yielded", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.succeed(1).pipe(
        Effect.withSpan("sync.op"),
        Effect.provide(tracerLayer(queue))
      )
      const result = yield* Queue.poll(queue)
      expect(Option.isSome(result)).toBe(true)
    })
  )
})

describe("formatPrettySpan", () => {
  it("renders name, kind, duration, status and attributes", () => {
    const output = formatPrettySpan({
      name: "collection.list",
      traceId: "abcdef0123456789",
      spanId: "0123456789abcdef",
      parentSpanId: undefined,
      kind: "client",
      durationMs: 1.234,
      status: "ok",
      error: undefined,
      attributes: { table: "posts" }
    })
    expect(output).toContain("[trace]")
    expect(output).toContain("collection.list")
    expect(output).toContain("client")
    expect(output).toContain("1.23ms")
    expect(output).toContain("ok")
    expect(output).toContain("table=posts")
    expect(output.startsWith("{")).toBe(false)
  })

  it("appends the error text for failed spans", () => {
    const output = formatPrettySpan({
      name: "op",
      traceId: "t",
      spanId: "s",
      parentSpanId: undefined,
      kind: "internal",
      durationMs: 0,
      status: "error",
      error: "kaboom",
      attributes: {}
    })
    expect(output).toContain("error")
    expect(output).toContain("kaboom")
  })
})
