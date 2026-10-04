import chalk from "chalk"
import { Cause, Effect, Exit, Layer, Option, Queue, Schema, Tracer } from "effect"

import { CryptoService } from "@/crypto/index.js"

import type { ConsolePrintOptions } from "./types.js"

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

const SpanAttributeValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])

const SpanOutputSchema = Schema.Struct({
  span: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  kind: Schema.String,
  durationMs: Schema.Number,
  status: Schema.Literals(["ok", "error"]),
  attributes: Schema.optionalKey(Schema.Record(Schema.String, SpanAttributeValueSchema)),
  parentSpanId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})

const encodeSpanLine = Schema.encodeEffect(Schema.fromJsonString(SpanOutputSchema))

const STATUS_COLORS: Record<"ok" | "error", (text: string) => string> = {
  ok: (text) => chalk.green(text),
  error: (text) => chalk.red(text)
}

/**
 * Renders a completed span for human-readable console output.
 * Used when `pretty: true` is passed to a console telemetry factory.
 */
export function formatPrettySpan(span: CompletedSpan): string {
  const header = [
    chalk.dim("[trace]"),
    chalk.bold(span.name),
    chalk.magenta(span.kind),
    chalk.cyan(`${span.durationMs.toFixed(2)}ms`),
    STATUS_COLORS[span.status](span.status)
  ].join(" ")
  const attributes = Object.entries(span.attributes)
  const attributeText =
    attributes.length > 0
      ? " " + chalk.dim(attributes.map(([key, value]) => `${key}=${String(value)}`).join(" "))
      : ""
  const errorText = span.error !== undefined ? `\n${chalk.red(span.error)}` : ""
  return `${header}${attributeText}${errorText}`
}

function printSpanJson(span: CompletedSpan) {
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

function printSpanPretty(span: CompletedSpan) {
  return Effect.sync(() => console.log(formatPrettySpan(span)))
}

const makePrintSpan = (pretty: boolean): ((span: CompletedSpan) => Effect.Effect<void>) =>
  pretty ? printSpanPretty : printSpanJson

class QueueSpan extends Tracer.NativeSpan {
  readonly #queue: Queue.Queue<CompletedSpan>
  constructor(
    queue: Queue.Queue<CompletedSpan>,
    options: ConstructorParameters<typeof Tracer.NativeSpan>[0]
  ) {
    super(options)
    this.#queue = queue
  }
  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit)
    const durationMs = Number(endTime - this.startTime) / 1_000_000
    const attributes: Record<string, string | number | boolean> = {}
    for (const [k, v] of this.attributes) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        attributes[k] = v
      }
    }
    Queue.offerUnsafe(this.#queue, {
      name: this.name,
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: Option.isSome(this.parent) ? this.parent.value.spanId : undefined,
      kind: this.kind,
      durationMs,
      status: Exit.isSuccess(exit) ? "ok" : "error",
      error: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined,
      attributes
    })
  }
}

export function makeConsoleTracer(
  queue: Queue.Queue<CompletedSpan>,
  _randomBytesSync: (size: number) => Uint8Array
): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      return new QueueSpan(queue, {
        name: options.name,
        parent: options.parent,
        annotations: options.annotations,
        links: options.links,
        startTime: options.startTime,
        kind: options.kind,
        sampled: options.sampled
      })
    }
  })
}

/**
 * Creates the console tracer layer that drains completed spans to stdout.
 * When `options.pretty` is `true`, spans are printed with Chalk coloring
 * instead of as raw JSON lines.
 *
 * @param options - Console print options (`pretty`, default `false`)
 */
export const makeConsoleTracerLayer = (
  options: ConsolePrintOptions = {}
): Layer.Layer<never, never, CryptoService> =>
  Layer.effect(
    Tracer.Tracer,
    Effect.gen(function* () {
      const cryptoSvc = yield* CryptoService
      const queue = yield* Queue.unbounded<CompletedSpan>()
      const printSpan = makePrintSpan(options.pretty ?? false)

      // Registered first → runs last (LIFO): drain items still in the queue at shutdown.
      yield* Effect.addFinalizer(() =>
        Queue.clear(queue).pipe(
          Effect.flatMap(Effect.forEach(printSpan)),
          Effect.asVoid
        )
      )

      // Registered second → runs first (LIFO): stop the consumer fiber.
      yield* Effect.forkScoped(Effect.forever(Queue.take(queue).pipe(Effect.tap(printSpan))))

      return makeConsoleTracer(queue, (size) => cryptoSvc.randomBytesSync(size))
    })
  )

/** Console tracer layer using raw JSON output (`pretty: false`). */
export const ConsoleTracerLayer: Layer.Layer<never, never, CryptoService> = makeConsoleTracerLayer()
