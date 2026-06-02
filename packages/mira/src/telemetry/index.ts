import { Layer } from "effect"
export type { CompletedSpan } from "./tracer.js"
export { ConsoleTracerLayer, makeConsoleTracer } from "./tracer.js"
export { ConsoleLoggerLayer, makeStructuredLogger } from "./logger.js"
export { makeSqliteTelemetryLayer } from "./sqlite-logger.js"
export type { SqliteLoggerConfig } from "./sqlite-logger.js"
import { ConsoleTracerLayer } from "./tracer.js"
import { ConsoleLoggerLayer } from "./logger.js"

export const ConsoleTelemetryLayer = Layer.merge(ConsoleTracerLayer, ConsoleLoggerLayer)
