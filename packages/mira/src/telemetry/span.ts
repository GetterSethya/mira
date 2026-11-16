import { Effect, References } from "effect"
import type { Tracer } from "effect"

/**
 * Apply a span only when the current fiber has tracing enabled.
 *
 * `Effect.withSpan` still builds a no-op span, installs an exit observer and
 * adds parent/stack-frame services when tracing is disabled. This helper skips
 * that allocation while preserving `CurrentStackFrame`, so failure causes still
 * name the operation. It is intended for hot request-path spans; use
 * `Effect.withSpan` when span topology must be preserved for scoped tracing
 * toggles.
 */
export const withSpanWhenEnabled =
  (name: string, options?: Tracer.SpanOptionsNoTrace, traceOptions?: Tracer.TraceOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) => {
    const capture = traceOptions?.captureStackTrace
    const stack =
      typeof capture === "function"
        ? capture
        : capture === false
          ? () => undefined
          : () => new Error().stack

    return Effect.withFiber((fiber) =>
      fiber.cache.tracerEnabled
        ? Effect.withSpan(name, options, traceOptions)(self)
        : Effect.updateService(References.CurrentStackFrame, (parent) => ({
            name,
            stack,
            parent
          }))(self)
    )
  }

/**
 * Annotate the current span only when tracing is enabled and a native span is
 * installed. The `tracerEnabled` guard matters in mixed scopes: a child scope
 * that disabled tracing must not write its attributes onto the enclosing real
 * span.
 */
export const annotateCurrentSpanWhenEnabled = (annotate: (span: Tracer.Span) => void) =>
  Effect.withFiber((fiber) => {
    if (!fiber.cache.tracerEnabled) return Effect.void
    const span = fiber.cache.span
    if (span === undefined || span._tag !== "Span") return Effect.void
    annotate(span)
    return Effect.void
  })
