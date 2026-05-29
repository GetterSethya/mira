import { Context, FiberRef, FiberRefs, Layer, Logger, Option, Schema, Tracer } from "effect"

const LogLineSchema = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
  traceId: Schema.optionalWith(Schema.String, { exact: true }),
  spanId: Schema.optionalWith(Schema.String, { exact: true }),
})

const encodeLogLine = Schema.encodeSync(Schema.parseJson(LogLineSchema))

export function makeStructuredLogger(): Logger.Logger<unknown, void> {
  return Logger.make(({ logLevel, message, date, context }) => {
    const ctx = FiberRefs.getOrDefault(context, FiberRef.currentContext)
    const spanOption = Context.getOption(ctx, Tracer.ParentSpan)

    const line: {
      level: string
      message: string
      timestamp: string
      traceId?: string
      spanId?: string
    } = {
      level: logLevel.label,
      message: String(Array.isArray(message) ? message.join(" ") : message),
      timestamp: date.toISOString(),
    }
    if (Option.isSome(spanOption)) {
      line.traceId = spanOption.value.traceId
      line.spanId = spanOption.value.spanId
    }

    console.log(encodeLogLine(line))
  })
}

export const ConsoleLoggerLayer: Layer.Layer<never> =
  Logger.replace(Logger.defaultLogger, makeStructuredLogger())
