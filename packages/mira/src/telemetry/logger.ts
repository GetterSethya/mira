import chalk from "chalk"
import type { Layer } from "effect"
import { Logger, Schema } from "effect"

import type { ConsolePrintOptions } from "./types.js"

const LogLineSchema = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String)
})

const encodeLogLine = Schema.encodeSync(Schema.fromJsonString(LogLineSchema))

export interface LogLine {
  level: string
  message: string
  timestamp: string
  traceId?: string
  spanId?: string
}

const LEVEL_COLORS: Record<string, (text: string) => string> = {
  TRACE: (text) => chalk.gray(text),
  DEBUG: (text) => chalk.magenta(text),
  INFO: (text) => chalk.cyan(text),
  WARN: (text) => chalk.yellow(text),
  ERROR: (text) => chalk.red(text),
  FATAL: (text) => chalk.bgRedBright.white(text)
}

function formatLevel(level: string): string {
  const paint = LEVEL_COLORS[level] ?? ((text: string) => chalk.white(text))
  return paint(level.padEnd(5))
}

/**
 * Renders a structured log line for human-readable console output.
 * Used when `pretty: true` is passed to a console telemetry factory.
 */
export function formatPrettyLog(line: LogLine): string {
  const time = chalk.dim(line.timestamp.slice(11, 23))
  const ids =
    line.traceId !== undefined
      ? chalk.dim(` ${line.traceId.slice(0, 8)}/${(line.spanId ?? "").slice(0, 8)}`)
      : ""
  return `${time} ${formatLevel(line.level)} ${line.message}${ids}`
}

/**
 * Creates a structured JSON logger. When `options.pretty` is `true`, each log
 * line is printed with Chalk coloring instead of as a raw JSON line.
 *
 * @param options - Console print options (`pretty`, default `false`)
 */
export function makeStructuredLogger(options: ConsolePrintOptions = {}): Logger.Logger<unknown, void> {
  const pretty = options.pretty ?? false

  return Logger.make(({ date, fiber, logLevel, message }) => {
    const span = fiber.cache.span

    const line: LogLine = {
      level: logLevel.toUpperCase(),
      message: String(Array.isArray(message) ? message.join(" ") : message),
      timestamp: date.toISOString()
    }
    if (span !== undefined) {
      line.traceId = span.traceId
      line.spanId = span.spanId
    }

    console.log(pretty ? formatPrettyLog(line) : encodeLogLine(line))
  })
}

/**
 * Creates the console logger layer.
 *
 * @param options - Console print options (`pretty`, default `false`)
 */
export const makeConsoleLoggerLayer = (options: ConsolePrintOptions = {}): Layer.Layer<never> =>
  Logger.layer([makeStructuredLogger(options)])

/** Console logger layer using raw JSON output (`pretty: false`). */
export const ConsoleLoggerLayer: Layer.Layer<never> = makeConsoleLoggerLayer()
