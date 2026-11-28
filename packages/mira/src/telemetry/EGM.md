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
  never produces it because its insert ignores duplicate ids; the tag lets a
  non-SQL store tell the core that a single row already exists.

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

- `TelemetryDatabase` - a preset layer providing both `SqlClient` and `Dialect`, plus optional `migrateAtStartup` (default true).
- `TelemetryStorageConfig` - dedicated (with a preset and optional
  `manageConnection`) or shared (with optional `migrate`, default true).
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
  the whole statement with `dialect.placeholder`. Telemetry reads pass a bound
  `caseInsensitivePattern` closure into `filterNodeToWhereClause`, so the
  pattern stays a bound parameter. PostgreSQL telemetry `like` filters use
  `ILIKE` while SQLite keeps `LIKE` [sql-store.ts:filterParts].
- A sentinel test replaces `caseInsensitivePattern` with a renderer that matches
  nothing. It covers both `listLogs` and `listSpans` through the shared
  `filterParts` helper, verifying the reads consult the dialect capability rather
  than a local hardcoded `LIKE` [sql-store.test.ts].
- The SQL store selects `seqId` for span cursors but does not expose it in the
  public span row, matching the current response JSON.
- Counts and read cursor values are coerced with `Number(...)` for drivers that
  return `int8` as strings. The read cursor stays numeric and is exact only below
  2^53; retention no longer depends on it.
- Append duplicate handling uses one insert with the dialect conflict clause,
  by default `ON CONFLICT (<id>) DO NOTHING`. A duplicate id is a no-op, so the
  SQL store never produces `TelemetryDuplicateEntryError` and never runs a
  recovery query after a failed statement.
- A direct store append inside a caller transaction commits or rolls back with
  it. The core's forked consumers run outside the caller transaction.
- The PostgreSQL transaction contract is covered by the environment-gated
  `postgres-shared` test. The default suite guards the generated SQL shape and
  SQLite transaction behavior.
- Retention is a batched delete with a progress guard; result counts are actual
  deletes, not selected ids. The shared statement wraps the limited `seqId`
  selection in a derived table, because MySQL 8.4 and MariaDB 11.4 reject a
  `LIMIT` directly inside an `IN` subquery. A `returning` dialect uses
  `RETURNING 1` and counts the returned rows; an `affectedRows` dialect runs the
  same delete without `RETURNING` and reads the affected count. A dialect with
  only `precheck` delete support fails with a descriptive error. The `seqId`
  never round-trips through a JavaScript number.
- An `affectedRows` reader must return `Some(n)` for a non-negative safe
  integer no larger than the 1,000-row batch, or `None` when the raw result is
  unreadable. `None`, a throw, and an impossible value fail with
  `TelemetryStoreError` naming the table, deleted-before count, and batch. A
  reader that keeps returning a positive count stops after 1,000 batches with a
  partial-run warning and returns the partial count.
- Dedicated and shared metadata tables are isolated. Dedicated keeps the
  defaults so an existing telemetry database upgrades without table
  re-creation. Shared uses the `_telemetry_*` pair.
- The SQL store builds a local `Migrator` from the resolved `SqlClient` and
  `Dialect`; it does not require the app-bound `Migrator`.
- `logCleanupCronDef` contains no SQL or PRAGMA. It logs actual deleted counts
  on success. On `TelemetryStoreError` it logs the cause and lets the error
  propagate, so `CronService` records `lastStatus: "error"` and fires the cron
  error hook instead of logging a zero-count success.
- Dedicated libSQL on a local `file:` reuses the SQLite setup and checkpoint.
  Remote libSQL uses `setup: []` and `cleanup: []`; sqld rejects writable
  pragmas. Retention still uses `DELETE ... RETURNING`.
- A libSQL `syncUrl` preset sets `TelemetryDatabase.migrateAtStartup` and
  `MiraDatabase.migrateAtStartup` to false. `makeTelemetryLayer` passes the flag
  to the SQL store, so dedicated telemetry does not create tables on a replica.
  Shared telemetry accepts `{ mode: "shared", migrate: false }` for the same
  reason.
- `makeSqlTelemetryStoreLayer` accepts `migrate?: boolean`. False skips table
  creation but keeps append/read/retention; a missing table surfaces as a store
  error on first use.
- For remote libSQL, set `flushBatchSize` and `flushInterval`; each unbatched
  row is one network round trip. The store is otherwise unchanged.

## PostgreSQL telemetry (issue #29)

- `postgresTelemetry` has `setup: []` and `cleanup: []`; there are no PRAGMAs and
  no WAL checkpoint. `isRetryable` reuses `postgresStoreSql.isRetryable` for
  `40001`, `40P01`, and `55P03` [dialect-postgres.ts:postgresTelemetry].
- The SQL store reads `Dialect.telemetry` and `Dialect.deleteResult`. PostgreSQL
  supplies the default `ON CONFLICT ("id") DO NOTHING` append suffix, so duplicate
  ids stay a no-op [sql-store.ts:deleteBatch].
- Shared mode is the recommended PostgreSQL mode: `makeTelemetryLayer({ storage: { mode: "shared" } })`
  reuses the app `SqlClient` and `Dialect`, creates `_telemetry_collections` and
  `_telemetry_migrations`, and migrates `logs` and `spans` in the app database.
  Dedicated mode opens a second pool and needs a separate database or schema
  [layer.ts:makeTelemetryLayer].
- Retention deletes through a derived table:
  `DELETE FROM "logs" WHERE "seqId" IN (SELECT "seqId" FROM (SELECT "seqId" FROM "logs" WHERE "created" < ? ORDER BY "seqId" LIMIT ?) AS "doomed") RETURNING 1`.
  The batch loop and progress guard stay. For `deleteResult: returning` the store
  counts returned rows; for `affectedRows` it reads the raw affected count,
  requires a non-negative safe integer no larger than the batch, and stops a
  stuck reader at 1,000 batches with a partial warning. The cutoff and batch
  size are the only parameters, in that order [sql-store.ts:deleteBatch].
- The high-water retention test advances `logs.seqId` with
  `ALTER TABLE logs ALTER COLUMN seqId RESTART WITH 9007199254740993`, inserts an
  old and a recent row, and asserts only the old row is deleted. The numeric read
  cursor is unchanged and remains exact only below 2^53
  [postgres-shared.test.ts].
- PostgreSQL appends run inside the caller transaction when a caller provides
  one and outside it for the forked consumers. A failed append maps through the
  dialect's retry and duplicate classifiers, never a SQLite error code
  [sql-store.ts:appendLogs].

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
- The environment-gated `tests/telemetry/postgres-shared.test.ts` runs against
  `MIRA_TEST_POSTGRES_URL`, creates both `logs` and `spans`, and covers the
  high-water retention subquery. It self-skips without the URL.

## MySQL and MariaDB telemetry (issue #30)

- `mysqlTelemetry` has empty `setup` and `cleanup`; there is no PRAGMA and no WAL checkpoint.
- `isRetryable` covers `1205` and `1213` for setup/migration. `retryDml: true` adds a one-attempt retry for appends and retention deletes through `isDmlRetryable`, which covers `1205` only. A `1213` deadlock already rolled back the caller's transaction, so re-issuing the insert would not preserve atomicity.
- Duplicate telemetry ids are ignored with `ON DUPLICATE KEY UPDATE <id> = <id>`; the telemetry store's batch-size bound is unchanged.
- Shared mode is recommended and uses the app pool. Dedicated mode needs its own `MysqlDatabase` and database. Retention uses the derived-table `seqId` subquery and does not run `OPTIMIZE TABLE`.
- The telemetry read path is numeric and exact only below 2^53. Retention is safe because it deletes through a `seqId` subquery.
