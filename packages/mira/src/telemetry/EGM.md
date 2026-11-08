# telemetry

## Overview

Tracing and structured-logging implementations for the Mira server. The console
path (`tracer.ts`, `logger.ts`) replaces the Effect `Tracer`/`Logger` with
implementations that print one JSON line per span/log (or Chalk-coloured lines
when `pretty` is set). Completed spans are never printed inline: `QueueSpan.end`
offers them synchronously to an unbounded queue, and a scoped consumer fiber
drains it. The SQLite path (`sqlite-logger.ts`, `telemetry-sql-client.ts`,
`collections.ts`) writes the same data into a dedicated log database (`logs` and
`spans` tables) and additionally exposes that database through
`TelemetrySqlClient` so the HTTP telemetry routes can read it. `index.ts`
merges the console tracer and logger into `makeConsoleTelemetryLayer`.

## Interface

### `types.ts`

- `ConsolePrintOptions` (type) — `{ pretty?: boolean }`; `pretty` selects Chalk rendering instead of raw JSON. [types.ts:ConsolePrintOptions]

### `tracer.ts`

- `CompletedSpan` (type) — `{ name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes }`. [tracer.ts:CompletedSpan]
- `formatPrettySpan(span)` — Chalk-rendered one-line span plus an optional red error line. [tracer.ts:formatPrettySpan]
- `makeConsoleTracer(queue, _randomBytesSync)` — builds a `Tracer.make` whose spans are `QueueSpan`s bound to the given queue. [tracer.ts:makeConsoleTracer]
- `makeConsoleTracerLayer(options)` — layer owning the unbounded span queue, a scoped drain fiber, a shutdown finalizer, and the tracer. [tracer.ts:makeConsoleTracerLayer]
- `ConsoleTracerLayer` — `makeConsoleTracerLayer()` default (JSON output). [tracer.ts:ConsoleTracerLayer]

### `logger.ts`

- `LogLine` (type) — `{ level, message, timestamp, traceId?, spanId? }`. [logger.ts:LogLine]
- `formatPrettyLog(line)` — Chalk-rendered log line with truncated trace/span ids. [logger.ts:formatPrettyLog]
- `makeStructuredLogger(options)` — `Logger.make` that emits JSON (or pretty) lines, attaching `traceId`/`spanId` from the fiber's current span. [logger.ts:makeStructuredLogger]
- `makeConsoleLoggerLayer(options)` — `Logger.layer([makeStructuredLogger(options)])`. [logger.ts:makeConsoleLoggerLayer]
- `ConsoleLoggerLayer` — `makeConsoleLoggerLayer()` default (JSON output). [logger.ts:ConsoleLoggerLayer]

### `index.ts`

- `makeConsoleTelemetryLayer(options)` — merges the console tracer layer and console logger layer. [index.ts:makeConsoleTelemetryLayer]
- `ConsoleTelemetryLayer` — default console telemetry (JSON). [index.ts:ConsoleTelemetryLayer]
- Barrel re-exporting `LogLine`, `ConsoleLoggerLayer`, `formatPrettyLog`, `makeConsoleLoggerLayer`, `makeStructuredLogger`, `SqliteLoggerConfig`, `logCleanupCronDef`, `makeSqliteTelemetryLayer`, `TelemetrySqlClient`, `CompletedSpan`, `ConsoleTracerLayer`, `formatPrettySpan`, `makeConsoleTracer`, `makeConsoleTracerLayer`, `ConsolePrintOptions`. [index.ts:ConsoleTelemetryLayer]

### `sqlite-logger.ts`

- `SqliteLoggerConfig` (type) — `{ dbPath?, logConsole?, pretty? }`. [sqlite-logger.ts:SqliteLoggerConfig]
- `logCleanupCronDef` — `CronDef` named `"mira:log-cleanup"`, `Schedule.cron("0 0 * * *")`, deleting `logs` and `spans` older than `logRetentionDays`. [sqlite-logger.ts:logCleanupCronDef]
- `makeSqliteTelemetryLayerForClient(config)` — layer over an ambient `SqlClient` + `CryptoService` that migrates the two telemetry collections, builds the SQLite logger, drains spans into `spans`, and returns the merged Logger/Tracer layer. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- `makeSqliteTelemetryLayer(config)` — self-contained layer: opens its own SQLite client at `config.dbPath ?? "mira-logs.db"`, wires `NodeCryptoLayer`, and merges the logger with `TelemetrySqlClient`. [sqlite-logger.ts:makeSqliteTelemetryLayer]

### `telemetry-sql-client.ts`

- `TelemetrySqlClient` — `Context.Service` tag carrying the dedicated telemetry `SqlClient`. [telemetry-sql-client.ts:TelemetrySqlClient]

### `collections.ts`

- `LogsCollection` — base collection `"logs"` with `level`, `message`, optional `traceId`/`spanId`. [collections.ts:LogsCollection]
- `SpansCollection` — base collection `"spans"` with `name`, `traceId`, `spanId`, optional `parentSpanId`, `kind`, `durationMs`, `status`, optional `error`, `attributes`. [collections.ts:SpansCollection]

No subdirectories.

## Invariants

- `QueueSpan.end` calls `super.end` first, then offers the span with `Queue.offerUnsafe` — span completion never blocks on I/O. [tracer.ts:QueueSpan]
- Only attributes whose value is `string | number | boolean` are copied into `CompletedSpan.attributes`; other attribute types are dropped. [tracer.ts:QueueSpan]
- Span status is `"ok"` for `Exit.isSuccess` and `"error"` (with `Cause.pretty`) otherwise. [tracer.ts:QueueSpan]
- Shutdown finalizers are registered so the drain fiber stops first and the remaining queue items are flushed last (LIFO ordering, documented inline). [tracer.ts:makeConsoleTracerLayer]
- `makeConsoleTracer` does not use its `_randomBytesSync` argument; ids come from the Effect `Tracer`, so the parameter is signature-only. [tracer.ts:makeConsoleTracer]
- JSON span output is emitted as a single line prefixed `[trace] `, with `attributes`/`parentSpanId`/`error` omitted when empty/undefined. [tracer.ts:printSpanJson]
- Pretty output is selected solely by `options.pretty ?? false` in both the console tracer and console logger. [tracer.ts:makeConsoleTracerLayer] [logger.ts:makeStructuredLogger]
- Log level is uppercased and array messages are joined with spaces. [logger.ts:makeStructuredLogger]
- Log lines carry `traceId`/`spanId` only when the emitting fiber has a current span. [logger.ts:makeStructuredLogger]
- SQLite log rows always include generated `id`, uppercase `level`, joined `message`, and identical `created`/`updated` ISO timestamps, plus `traceId`/`spanId` when a span is active. [sqlite-logger.ts:makeSqliteLogger]
- Log insertion is fire-and-forget: `Effect.runPromise(...).catch(() => {})`, so a failing log write never fails the caller and is silent. [sqlite-logger.ts:makeSqliteLogger]
- Span rows JSON-encode `attributes` and store `parentSpanId`/`error` as `null` when absent. [sqlite-logger.ts:writeSpanToDb]
- The SQLite telemetry layer migrates `LogsCollection` and `SpansCollection` during layer construction and dies on failure. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- `makeSqliteTelemetryLayer` resolves its own `SqlClient` from the configured `dbPath` (default `"mira-logs.db"`) and also re-provides it as `TelemetrySqlClient`. [sqlite-logger.ts:makeSqliteTelemetryLayer]
- `SqliteLoggerConfig.logConsole` gates console echo; `pretty` only affects the echo, not database contents. [sqlite-logger.ts:SqliteLoggerConfig]
- `logCleanupCronDef` computes the cutoff from `AppConfig.logRetentionDays` in days and deletes from both `logs` and `spans`. [sqlite-logger.ts:logCleanupCronDef]
- Only `TelemetrySqlClient` and `AppConfig` are required by the cleanup cron handler. [sqlite-logger.ts:logCleanupCronDef]
- The logger/tracer hold a reference to the same ambient `SqlClient` they were built with; the layer expects `SqlClient.SqlClient | CryptoService`. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- `makeSqliteTelemetryLayerForClient` is exported for testing and is not part of the `index.ts` barrel. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- `TelemetrySqlClient` must stay separate from the app's primary `SqlClient` to avoid contention (documented on the tag). [telemetry-sql-client.ts:TelemetrySqlClient]

## Side Effects

- Writes to stdout via `console.log` for every span (`[trace] {json}` or pretty form) and, when `logConsole` is set, for every log line. [tracer.ts:printSpanJson] [sqlite-logger.ts:makeSqliteLogger]
- Opens and writes a dedicated SQLite database file (`mira-logs.db` by default) with `logs` and `spans` tables. [sqlite-logger.ts:makeSqliteTelemetryLayer]
- Runs schema migrations for the telemetry collections at layer construction. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- Uses an unbounded in-memory `Queue<CompletedSpan>` plus a scoped consumer fiber and a shutdown finalizer in both console and SQLite paths. [tracer.ts:makeConsoleTracerLayer] [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- Generates row ids with Node `Buffer` over `CryptoService.randomBytesSync`. [sqlite-logger.ts:makeSqliteLogger]
- `logCleanupCronDef` performs scheduled `DELETE` statements against the telemetry database and logs the cutoff via `Effect.logInfo`. [sqlite-logger.ts:logCleanupCronDef]
- Span attribute encoding failures terminate the write with `Effect.orDie` rather than surfacing in the effect's error channel. [sqlite-logger.ts:writeSpanToDb]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
