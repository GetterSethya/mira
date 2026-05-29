import { Effect, Layer, Queue, Schema } from "effect"
import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, it } from "@effect/vitest"
import { expect, vi } from "vitest"
import type { MockInstance } from "vitest"
import { ConsoleLoggerLayer } from "@/telemetry/logger.js"
import type { CompletedSpan } from "@/telemetry/tracer.js"
import { makeConsoleTracer } from "@/telemetry/tracer.js"

const LogLineSchema = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
  traceId: Schema.optionalWith(Schema.String, { exact: true }),
  spanId: Schema.optionalWith(Schema.String, { exact: true }),
})

function parseLogLine(raw: unknown) {
  return Schema.decodeUnknown(Schema.parseJson(LogLineSchema))(raw).pipe(Effect.orDie)
}

describe("makeStructuredLogger", () => {
  let spy: MockInstance

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it.effect("emits JSON with level and message", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("hello world")
      expect(spy.mock.calls.length).toBeGreaterThan(0)
      const output = yield* parseLogLine(spy.mock.calls[0][0])
      expect(output.level).toBe("INFO")
      expect(output.message).toBe("hello world")
    }).pipe(Effect.provide(ConsoleLoggerLayer))
  )

  it.effect("respects log level label", () =>
    Effect.gen(function* () {
      yield* Effect.logError("fail")
      const output = yield* parseLogLine(spy.mock.calls[0][0])
      expect(output.level).toBe("ERROR")
    }).pipe(Effect.provide(ConsoleLoggerLayer))
  )

  it.effect("timestamp is a valid ISO string", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("ts-check")
      const output = yield* parseLogLine(spy.mock.calls[0][0])
      expect(new Date(output.timestamp).getTime()).not.toBeNaN()
    }).pipe(Effect.provide(ConsoleLoggerLayer))
  )

  it.effect("no traceId outside a span", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("no-span")
      const output = yield* parseLogLine(spy.mock.calls[0][0])
      expect(output.traceId).toBeUndefined()
    }).pipe(Effect.provide(ConsoleLoggerLayer))
  )

  it.effect("traceId is present inside a span", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      yield* Effect.logInfo("in-span").pipe(
        Effect.withSpan("op"),
        Effect.provide(
          Layer.mergeAll(
            ConsoleLoggerLayer,
            Layer.setTracer(makeConsoleTracer(queue, (size) => randomBytes(size))),
          )
        )
      )
      expect(spy.mock.calls.length).toBeGreaterThan(0)
      const output = yield* parseLogLine(spy.mock.calls[0][0])
      expect(typeof output.traceId).toBe("string")
      expect(output.traceId?.length).toBeGreaterThan(0)
    })
  )
})
