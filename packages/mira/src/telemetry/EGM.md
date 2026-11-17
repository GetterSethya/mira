# telemetry

## Overview

Tracing and structured logging for Mira. The console path (`tracer.ts`,
`logger.ts`) prints one JSON line per span/log (or Chalk lines when `pretty` is
set). Persistence goes through `TelemetryStore` (`store.ts`): the SQL-free core
(`core.ts`) owns queueing, batching, draining, and shutdown finalizers, while
`sql-store.ts` owns SQL appends, retention, reads, and migrations. `layer.ts`
composes the two and exports the retention cron.

`index.ts` merges the store, core, and SQL store; `index-core.ts` exposes only
the console path so a non-SQL app can import it without pulling SQL code into
its module graph.

## Interface

### `store.ts`

- `TelemetryLogEntry` / `TelemetrySpanEntry` — rows ready for persistence; the
  core generates ids and timestamps before calling the store.
- `TelemetryListQuery`, `TelemetryLogPage`, `TelemetrySpanPage`,
  `TelemetryDeleteResult`, and the public row types.
- `TelemetryReadShape` — `listLogs` and `listSpans`.
- `TelemetryStoreShape` — `appendLogs`, `appendSpans`, `deleteOlderThan`, and
  `read: TelemetryReadShape | null`.
- `TelemetryStore` — the `Context.Service` the core depends on.
- `TelemetryStoreError` — tagged persistence failure (`operation`, `cause`).
- `TelemetryDuplicateEntryError` — tagged duplicate-key failure. The SQL store
  normally resolves duplicates internally; the tag lets a non-SQL store tell the
  core that a single row already exists.

### `core.ts`

- `TelemetryCoreConfig` — `logConsole`, `pretty`, `flushBatchSize` (default 1,
  clamped to 1..1,000), and optional `flushInterval`.
- `makeTelemetryLayerForClient(config)` — requires `TelemetryStore |
  CryptoService`, provides the Effect `Logger` and `Tracer`, and has no
  `SqlClient`, `Dialect`, `Migrator`, or SQL import.

### `sql-store.ts`

- `makeSqlTelemetryStoreLayer({ dedicated, manageConnection })` — requires
  `SqlClient | Dialect`, provides `TelemetryStore`.
  - `dedicated: true` uses `_collections` / `_migrations`; `dedicated: false`
    uses `_telemetry_collections` / `_telemetry_migrations`.
  - `manageConnection` controls dialect setup/cleanup only. Shared mode cannot
    set it to true at the type level.
- `SqlTelemetryStoreLive` — dedicated-mode convenience layer.

### `layer.ts`

- `TelemetryDatabase` — a preset layer providing both `SqlClient` and `Dialect`.
- `TelemetryStorageConfig` — dedicated (with a preset and optional
  `manageConnection`) or shared.
- `TelemetryLoggerConfig` — core config plus storage.
- `makeTelemetryLayer(config)` — composes the store and core with
  `Layer.provideMerge`, so `TelemetryStore` stays in the output.
- `logCleanupCronDef` — `CronDef<TelemetryStore | AppConfig>`.

### `collections.ts`

- `LogsCollection` — `logs` with `level`, `message`, optional `traceId`/`spanId`,
  indexed on `created`.
- `SpansCollection` — `spans` with `name`, `traceId`, `spanId`, optional
  `parentSpanId`, `kind`, `durationMs`, `status`, optional `error`,
  `attributes`, indexed on `created`.

## Invariants

- The telemetry core never imports `SqlClient`, `Dialect`, `Migrator`, or the
  SQL store. A fake store proves the boundary.
- Log ids and row timestamps are generated in the core. Log `traceId`/`spanId`
  are normalized to `string | null` before batching.
- The log queue is bounded at 10,000; a full queue drops the row, increments a
  counter, and reports the count at shutdown. The span queue is unbounded.
- The default `flushBatchSize` is 1 and preserves one-store-call-per-row
  behavior. `flushInterval` uses a `Ref` buffer and a scoped timer; the queue
  take is never wrapped in a timeout.
- Appends are at-least-once with id-based deduplication. A retry of a committed
  row must be a no-op.
- A failed batch is split in half recursively. A single duplicate row is
  success; a single non-duplicate row is logged as lost. Split depth and total
  attempts are capped per initial batch.
- The consumer keeps unacknowledged rows in a `Ref`; acknowledged sub-batches
  are removed immediately. Shutdown re-flushes only unacknowledged rows.
- Drain has a two-second deadline per queue. A failed drain is logged and never
  throws.
- The SQL store quotes every generated identifier with
  `dialect.quoteIdentifier`. Filters keep `?` placeholders; the store rewrites
  the whole statement with `dialect.placeholder`.
- The SQL store selects `seqId` for span cursors but does not expose it in the
  public span row, matching the current response JSON.
- Counts and cursor values are coerced with `Number(...)` for drivers that
  return `int8` as strings.
- Append duplicate handling filters existing ids and retries only the missing
  rows in one insert. `TelemetryDuplicateEntryError` crosses the boundary only
  when that retry still fails.
- Retention is a select-then-delete loop with a progress guard; result counts
  are actual deletes, not selected ids. A dialect with only `precheck` delete
  support fails with a descriptive error.
- Dedicated and shared metadata tables are isolated. Dedicated keeps the
  defaults so an existing telemetry database upgrades without table
  re-creation. Shared uses the `_telemetry_*` pair.
- The SQL store builds a local `Migrator` from the resolved `SqlClient` and
  `Dialect`; it does not require the app-bound `Migrator`.
- `logCleanupCronDef` contains no SQL or PRAGMA. It logs actual deleted counts
  and completes on `TelemetryStoreError`.

## Side Effects

- Writes to stdout for every span (`[trace] {json}` or pretty form) and, when
  `logConsole` is set, for every log line.
- Opens and writes the configured SQL database, creating `logs`, `spans`, and
  the metadata tables.
- Dedicated mode applies the dialect setup statements (SQLite WAL, `NORMAL`,
  and busy timeout) and runs cleanup after retention unless
  `manageConnection: false`.
- Spawns one scoped consumer per queue plus an optional interval timer. They
  stop before the drain finalizers.
- The cleanup cron performs batched deletes through `deleteOlderThan` and runs
  the dialect cleanup hook.

## Verification

- `pnpm --filter @gettersethya/mira test`
- `pnpm --filter @gettersethya/mira typecheck`
- `pnpm -r typecheck`
- Tests cover the fake-store boundary, SQL append/dedup, retention counts,
  filtering/cursors, span grouping, dialect hooks, metadata isolation, shared
  and dedicated wiring, batching, and shutdown drain.
