import { randomBytes } from "node:crypto"

import { describe, it } from "@effect/vitest"
import { Cause, Data, Effect, Exit, Queue, Tracer } from "effect"
import { expect } from "vitest"

import type { CompletedSpan } from "@/telemetry/tracer.js"
import { makeConsoleTracer } from "@/telemetry/tracer.js"
import { annotateCurrentSpanWhenEnabled, withSpanWhenEnabled } from "@/telemetry/span.js"

function makeTracer(queue: Queue.Queue<CompletedSpan>) {
  return makeConsoleTracer(queue, (size) => randomBytes(size))
}

class HelperFailure extends Data.TaggedError("HelperFailure")<{}> {}

describe("withSpanWhenEnabled", () => {
  it.effect("emits the span and annotations when tracing is enabled", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      const tracer = makeTracer(queue)
      yield* Effect.gen(function* () {
        yield* annotateCurrentSpanWhenEnabled((span) => span.attribute("helper.attribute", "yes"))
      }).pipe(
        withSpanWhenEnabled(
          "helper.span",
          { kind: "internal", attributes: { helper: true } },
          { captureStackTrace: false }
        )
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))

      const spans = yield* Queue.clear(queue)
      const span = spans.find((candidate) => candidate.name === "helper.span")
      expect(span).toBeDefined()
      expect(span?.attributes["helper"]).toBe(true)
      expect(span?.attributes["helper.attribute"]).toBe("yes")
    })
  )

  it.effect("emits no span when tracing is disabled", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CompletedSpan>()
      const tracer = makeTracer(queue)
      yield* Effect.gen(function* () {
        yield* annotateCurrentSpanWhenEnabled((span) => span.attribute("must.not.leak", true))
      }).pipe(
        withSpanWhenEnabled(
          "helper.disabled",
          { kind: "internal" },
          { captureStackTrace: false }
        ),
        Effect.withTracerEnabled(false)
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))

      expect(yield* Queue.clear(queue)).toHaveLength(0)
    })
  )

  it.effect("preserves the operation name in a failure cause when disabled", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.fail(new HelperFailure()).pipe(
        withSpanWhenEnabled(
          "helper.failure",
          { kind: "internal" },
          { captureStackTrace: false }
        ),
        Effect.withTracerEnabled(false),
        Effect.exit
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("helper.failure")
      }
    })
  )

  it.effect("annotation is a no-op when tracing is enabled but no span is installed", () =>
    Effect.gen(function* () {
      yield* annotateCurrentSpanWhenEnabled(() => {
        throw new Error("must not run")
      })
    })
  )
})
