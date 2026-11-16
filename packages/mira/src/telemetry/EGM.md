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
`TelemetrySqlClient` so the HTTP telemetry routes can read it. The SQLite path is
driver-neutral: the caller supplies a `SqlClient` layer for a dedicated telemetry
database. `index.ts` merges the console tracer and logger into
`makeConsoleTelemetryLayer`.

## Interface

### `types.ts`

- `ConsolePrintOptions` (type) — `{ pretty?: boolean }`; `pretty` selects Chalk rendering instead of raw JSON. [types.ts:ConsolePrintOptions]

### `tracer.ts`

- `CompletedSpan` (type) — `{ name, traceId, spanId, parentSpanId, kind, durationMs, status, error, attributes }`. [tracer.ts:CompletedSpan]
- `formatPrettySpan(span)` — Chalk-rendered one-line span plus an optional red error line. [tracer.ts:formatPrettySpan]
- `makeConsoleTracer(queue, _randomBytesSync)` — builds a `Tracer.make` whose spans are `QueueSpan`s bound to the given queue. [tracer.ts:makeConsoleTracer]
- `makeConsoleTracerLayer(options)` — layer owning the unbounded span queue, a scoped drain fiber, a shutdown finalizer, and the tracer. [tracer.ts:makeConsoleTracerLayer]
- `ConsoleTracerLayer` — `makeConsoleTracerLayer()` default (JSON output). [tracer.ts:ConsoleTracerLayer]

### `span.ts`

- `withSpanWhenEnabled(name, options?, traceOptions?)` — applies `Effect.withSpan` when the fiber has tracing enabled; otherwise skips the no-op span and preserves `References.CurrentStackFrame` so failure causes still name the operation. [span.ts:withSpanWhenEnabled]

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

- `SqliteLoggerConfig` (type) — `{ sqlLayer, logConsole?, pretty? }`; `sqlLayer` is a `Layer<SqlClient.SqlClient, never, never>` for a dedicated telemetry database. [sqlite-logger.ts:SqliteLoggerConfig]
- `logCleanupCronDef` — `CronDef<TelemetrySqlClient | AppConfig>` named `"mira:log-cleanup"`, `Schedule.cron("0 0 * * *")`, deleting `logs` and `spans` older than `logRetentionDays` in batches. [sqlite-logger.ts:logCleanupCronDef]
- `makeSqliteTelemetryLayerForClient(config)` — layer over an ambient `SqlClient` + `CryptoService` that applies the telemetry PRAGMAs, migrates the two telemetry collections, builds the queued SQLite logger/tracer, and returns the merged Logger/Tracer layer. Exported for tests. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- `makeSqliteTelemetryLayer(config)` — driver-neutral layer: provides `config.sqlLayer` to the logger and re-exposes it as `TelemetrySqlClient`; requires `CryptoService` and dies on layer failure. [sqlite-logger.ts:makeSqliteTelemetryLayer]

### `telemetry-sql-client.ts`

- `TelemetrySqlClient` — `Context.Service` tag carrying the dedicated telemetry `SqlClient`. [telemetry-sql-client.ts:TelemetrySqlClient]

### `collections.ts`

- `LogsCollection` — base collection `"logs"` with `level`, `message`, optional `traceId`/`spanId`, indexed on `created`. [collections.ts:LogsCollection]
- `SpansCollection` — base collection `"spans"` with `name`, `traceId`, `spanId`, optional `parentSpanId`, `kind`, `durationMs`, `status`, optional `error`, `attributes`, indexed on `created`. [collections.ts:SpansCollection]

No subdirectories.

## Invariants

- `QueueSpan.end` calls `super.end` first, then offers the span with `Queue.offerUnsafe` — span completion never blocks on I/O. [tracer.ts:QueueSpan]
- `withSpanWhenEnabled` is identity-safe for tracing-on span names/attributes; when tracing is off it skips the no-op span but preserves the `CurrentStackFrame` chain, so `Cause.pretty` still names the operation. It is used by the hot request path (HTTP, collection service, cache, hooks, mutation batcher, repository). [span.ts:withSpanWhenEnabled]
- `annotateCurrentSpanWhenEnabled` guards on `fiber.cache.tracerEnabled` *and* a native `fiber.cache.span`, so a tracing-disabled child scope cannot write attributes onto an enclosing span; it is used for `auth.*`, `cache.hit`, and `http.forwarded_for`. [span.ts:annotateCurrentSpanWhenEnabled]
- Only attributes whose value is `string | number | boolean` are copied into `CompletedSpan.attributes`; other attribute types are dropped. [tracer.ts:QueueSpan]
- Span status is `"ok"` for `Exit.isSuccess` and `"error"` (with `Cause.pretty`) otherwise. [tracer.ts:QueueSpan]
- Shutdown finalizers are registered so the drain fiber stops first and the remaining queue items are flushed last (LIFO ordering, documented inline). [tracer.ts:makeConsoleTracerLayer]
- `makeConsoleTracer` does not use its `_randomBytesSync` argument; ids come from the Effect `Tracer`, so the parameter is signature-only. [tracer.ts:makeConsoleTracer]
- JSON span output is emitted as a single line prefixed `[trace] `, with `attributes`/`parentSpanId`/`error` omitted when empty/undefined. [tracer.ts:printSpanJson]
- Pretty output is selected solely by `options.pretty ?? false` in both the console tracer and console logger. [tracer.ts:makeConsoleTracerLayer] [logger.ts:makeStructuredLogger]
- Log level is uppercased and array messages are joined with spaces. [logger.ts:makeStructuredLogger]
- Log lines carry `traceId`/`spanId` only when the emitting fiber has a current span. [logger.ts:makeStructuredLogger]
- SQLite log rows always include generated `id`, uppercase `level`, joined `message`, and identical `created`/`updated` ISO timestamps, plus `traceId`/`spanId` when a span is active. [sqlite-logger.ts:makeSqliteLogger]
- Log rows are offered with `Queue.offerUnsafe` to a bounded queue (capacity 10,000); a full queue drops the row, increments a counter, and never fails the caller. [sqlite-logger.ts:makeSqliteLogger]
- Span rows JSON-encode `attributes` and store `parentSpanId`/`error` as `null` when absent. [sqlite-logger.ts:writeSpanToDb]
- Layer construction applies `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, and `PRAGMA busy_timeout = 5000`, then migrates `LogsCollection` and `SpansCollection`. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- The setup effect retries only SQLite `SQLITE_BUSY`/`SQLITE_LOCKED` lock timeouts, with exponential backoff (`100 millis`, up to 4 retries); other failures die. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- `makeSqliteTelemetryLayer` provides the caller-supplied `sqlLayer` to both the logger and the `TelemetrySqlClient` tag; it does not open a database itself. [sqlite-logger.ts:makeSqliteTelemetryLayer]
- `sqlLayer` must point at a dedicated telemetry database, not the application database; the config doc says so, and `TelemetrySqlClient` exists to keep the two clients apart. [sqlite-logger.ts:SqliteLoggerConfig] [telemetry-sql-client.ts:TelemetrySqlClient]
- `SqliteLoggerConfig.logConsole` gates console echo; `pretty` only affects the echo, not database contents. [sqlite-logger.ts:SqliteLoggerConfig]
- `logCleanupCronDef` computes the cutoff from `AppConfig.logRetentionDays` in days and deletes from both `logs` and `spans` in batches of 1,000 rows. [sqlite-logger.ts:logCleanupCronDef]
- The cleanup job finishes with `PRAGMA wal_checkpoint(TRUNCATE)`; a failed checkpoint is logged as a warning, and a busy checkpoint logs a second warning instead of failing the job. [sqlite-logger.ts:logCleanupCronDef]
- Only `TelemetrySqlClient` and `AppConfig` are required by the cleanup cron handler, so it has no effect without the SQLite telemetry layer. [sqlite-logger.ts:logCleanupCronDef]
- The logger/tracer hold a reference to the same ambient `SqlClient` they were built with; the layer expects `SqlClient.SqlClient | CryptoService`. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- `makeSqliteTelemetryLayerForClient` is exported for testing and is not part of the `index.ts` barrel. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]

## Side Effects

- Writes to stdout via `console.log` for every span (`[trace] {json}` or pretty form) and, when `logConsole` is set, for every log line. [tracer.ts:printSpanJson] [sqlite-logger.ts:makeSqliteLogger]
- Opens and writes a dedicated SQLite database supplied through `SqliteLoggerConfig.sqlLayer`, with `logs` and `spans` tables. [sqlite-logger.ts:makeSqliteTelemetryLayer]
- Applies WAL, `synchronous=NORMAL`, and `busy_timeout=5000`, then runs schema migrations for the telemetry collections at layer construction. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- Uses a bounded `Queue<LogRow>` (10,000) and an unbounded `Queue<CompletedSpan>`, each with a scoped consumer fiber and a shutdown finalizer that drains remaining rows with a 2-second timeout. [sqlite-logger.ts:makeSqliteTelemetryLayerForClient]
- Reports dropped log rows and failed drains to stderr; individual write failures are caught and logged rather than failing the layer. [sqlite-logger.ts:safeWriteLogRow] [sqlite-logger.ts:drainRows]
- Generates row ids with Node `Buffer` over `CryptoService.randomBytesSync`. [sqlite-logger.ts:makeSqliteLogger]
- `logCleanupCronDef` performs scheduled batched `DELETE` statements against the telemetry database, checkpoints the WAL, and logs the cutoff via `Effect.logInfo`. [sqlite-logger.ts:logCleanupCronDef]
- Span attribute encoding failures terminate the write with `Effect.orDie` rather than surfacing in the effect's error channel. [sqlite-logger.ts:writeSpanToDb]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
