import { randomBytes } from "node:crypto"

import { afterEach, beforeEach, describe, it } from "@effect/vitest"
import { Effect, Layer, Queue, Schema, Tracer } from "effect"
import type { MockInstance } from "vitest"
import { expect, vi } from "vitest"

import { ConsoleLoggerLayer, formatPrettyLog, makeConsoleLoggerLayer } from "@/telemetry/logger.js"
import type { CompletedSpan } from "@/telemetry/tracer.js"
import { makeConsoleTracer } from "@/telemetry/tracer.js"

const LogLineSchema = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
})

function parseLogLine(raw: unknown) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(LogLineSchema))(raw).pipe(Effect.orDie)
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
            Layer.succeed(Tracer.Tracer, makeConsoleTracer(queue, (size) => randomBytes(size))),
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

describe("formatPrettyLog", () => {
  it("renders level, message and ids as a human-readable line", () => {
    const output = formatPrettyLog({
      level: "ERROR",
      message: "boom",
      timestamp: "2026-10-04T08:07:42.159Z",
      traceId: "abcdef0123456789",
      spanId: "0123456789abcdef"
    })
    expect(output).toContain("ERROR")
    expect(output).toContain("boom")
    expect(output).toContain("abcdef01/01234567")
    expect(output.startsWith("{")).toBe(false)
  })
})

describe("makeConsoleLoggerLayer({ pretty: true })", () => {
  let spy: MockInstance

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it.effect("prints a non-JSON line", () =>
    Effect.gen(function* () {
      yield* Effect.logInfo("pretty hello")
      const output = spy.mock.calls[0][0]
      expect(typeof output).toBe("string")
      expect(output).toContain("INFO")
      expect(output).toContain("pretty hello")
      expect(output.startsWith("{")).toBe(false)
    }).pipe(Effect.provide(makeConsoleLoggerLayer({ pretty: true })))
  )
})
