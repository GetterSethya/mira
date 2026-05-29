import { Cause, Effect, Exit, Layer, Option, Queue, Schema, Tracer } from "effect"
import { CryptoService } from "@/crypto/index.js"

export interface CompletedSpan {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly kind: string
  readonly durationMs: number
  readonly status: "ok" | "error"
  readonly error: string | undefined
  readonly attributes: Record<string, string | number | boolean>
}

const SpanAttributeValueSchema = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)

const SpanOutputSchema = Schema.Struct({
  span: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  kind: Schema.String,
  durationMs: Schema.Number,
  status: Schema.Literal("ok", "error"),
  attributes: Schema.optionalWith(Schema.Record({ key: Schema.String, value: SpanAttributeValueSchema }), {
    exact: true
  }),
  parentSpanId: Schema.optionalWith(Schema.String, { exact: true }),
  error: Schema.optionalWith(Schema.String, { exact: true })
})

const encodeSpanLine = Schema.encode(Schema.parseJson(SpanOutputSchema))

function printSpan(span: CompletedSpan) {
  const line: {
    span: string
    traceId: string
    spanId: string
    kind: string
    durationMs: number
    status: "ok" | "error"
    attributes?: Record<string, string | number | boolean>
    parentSpanId?: string
    error?: string
  } = {
    span: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    kind: span.kind,
    durationMs: span.durationMs,
    status: span.status
  }
  if (Object.keys(span.attributes).length > 0) line.attributes = span.attributes
  if (span.parentSpanId !== undefined) line.parentSpanId = span.parentSpanId
  if (span.error !== undefined) line.error = span.error
  return encodeSpanLine(line).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) => Effect.sync(() => console.log(`[trace] ${encoded}`)))
  )
}

export function makeConsoleTracer(
  queue: Queue.Queue<CompletedSpan>,
  randomBytesSync: (size: number) => Uint8Array
): Tracer.Tracer {
  return Tracer.make({
    span(name, parent, context, links, startTime, kind, options) {
      const spanId = Buffer.from(randomBytesSync(8)).toString("hex")
      const traceId = Option.isSome(parent) ? parent.value.traceId : Buffer.from(randomBytesSync(16)).toString("hex")
      const attrs = new Map<string, unknown>()

      if (options?.attributes) {
        for (const [k, v] of Object.entries(options.attributes)) {
          attrs.set(k, v)
        }
      }

      let currentStatus: Tracer.SpanStatus = { _tag: "Started", startTime }

      const span: Tracer.Span = {
        _tag: "Span",
        name,
        spanId,
        traceId,
        parent,
        context,
        links,
        kind,
        sampled: true,
        get status() {
          return currentStatus
        },
        get attributes(): ReadonlyMap<string, unknown> {
          return attrs
        },
        attribute(key: string, value: unknown) {
          attrs.set(key, value)
        },
        end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
          currentStatus = { _tag: "Ended", startTime, endTime, exit }
          const durationMs = Number(endTime - startTime) / 1_000_000
          const attributes: Record<string, string | number | boolean> = {}
          for (const [k, v] of attrs) {
            if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
              attributes[k] = v
            }
          }
          Queue.unsafeOffer(queue, {
            name,
            traceId,
            spanId,
            parentSpanId: Option.isSome(parent) ? parent.value.spanId : undefined,
            kind,
            durationMs,
            status: Exit.isSuccess(exit) ? "ok" : "error",
            error: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined,
            attributes
          })
        },
        event() {},
        addLinks() {}
      }

      return span
    },
    context(f, _fiber) {
      return f()
    }
  })
}

export const ConsoleTracerLayer: Layer.Layer<never, never, CryptoService> = Layer.unwrapScoped(
  Effect.gen(function* () {
    const cryptoSvc = yield* CryptoService
    const queue = yield* Queue.unbounded<CompletedSpan>()

    // Registered first → runs last (LIFO): drain items still in the queue at shutdown.
    yield* Effect.addFinalizer(() =>
      Queue.takeAll(queue).pipe(
        Effect.flatMap(Effect.forEach(printSpan)),
        Effect.asVoid
      )
    )

    // Registered second → runs first (LIFO): stop the consumer fiber.
    yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.tap(printSpan))))

    return Layer.setTracer(makeConsoleTracer(queue, (size) => cryptoSvc.randomBytesSync(size)))
  })
)
