import { Layer } from "effect"

import { makeConsoleLoggerLayer } from "./logger.js"
import { makeConsoleTracerLayer } from "./tracer.js"
import type { ConsolePrintOptions } from "./types.js"

export type { LogLine } from "./logger.js"
export { ConsoleLoggerLayer, formatPrettyLog, makeConsoleLoggerLayer, makeStructuredLogger } from "./logger.js"
export { TelemetrySqlClient } from "./telemetry-sql-client.js"
export type { CompletedSpan } from "./tracer.js"
export { ConsoleTracerLayer, formatPrettySpan, makeConsoleTracer, makeConsoleTracerLayer } from "./tracer.js"
export type { ConsolePrintOptions } from "./types.js"

/**
 * Creates a console telemetry layer (tracer + logger). Pass `{ pretty: true }`
 * to print logs and spans with Chalk coloring instead of raw JSON lines.
 *
 * This module has no Node SQLite import, so the Bun entry and the app builder
 * can use it without loading `@effect/sql-sqlite-node`.
 *
 * @param options - Console print options (`pretty`, default `false`)
 */
export const makeConsoleTelemetryLayer = (options: ConsolePrintOptions = {}) =>
  Layer.merge(makeConsoleTracerLayer(options), makeConsoleLoggerLayer(options))

/** Console telemetry layer using raw JSON output (`pretty: false`). */
export const ConsoleTelemetryLayer = makeConsoleTelemetryLayer()
