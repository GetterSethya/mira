# Telemetry architecture

```text
Effect Logger / Tracer
        |
        v
 bounded log queue (10,000)    unbounded span queue
        |                              |
        +--------------+---------------+
                       v
              telemetry core (core.ts)
        batching, split retry, drain, shutdown
                       |
                       v
                 TelemetryStore
        appendLogs, appendSpans,
        deleteOlderThan, read | null
                       |
          +------------+------------+
          |                         |
          v                         v
  SqlTelemetryStore          non-SQL sink
  (sql-store.ts)             (OTLP, S3, memory)
        |
        v
  dedicated preset or app SqlClient + Dialect
```

## Dedicated setup

```ts
.telemetry(makeTelemetryLayer({
  storage: {
    mode: "dedicated",
    database: SqliteDatabase({ filename: "mira-logs.db" }),
  },
}))
```

Dedicated mode takes both `SqlClient` and `Dialect` from the preset, runs the
dialect setup and cleanup hooks, and uses the default `_collections` /
`_migrations` metadata. Set `manageConnection: false` to keep a preset's
explicit `synchronous` setting and skip telemetry setup/cleanup.

## Shared setup

```ts
.telemetry(makeTelemetryLayer({ storage: { mode: "shared" } }))
```

Shared mode reuses the application `SqlClient` and `Dialect`, runs no setup or
cleanup, and stores telemetry migration metadata in `_telemetry_collections` and
`_telemetry_migrations`. An application transaction can include or roll back a
telemetry write; that is the documented trade-off that makes shared mode work on
PGlite and browser OPFS.

## Dialect hooks

`DialectType.telemetry` supplies:

- `setup`: connection statements for a dedicated connection. SQLite and local
  libSQL use WAL, `synchronous=NORMAL`, and a busy timeout; remote libSQL uses an
  empty list because sqld rejects writable pragmas.
- `cleanup`: statements after retention. SQLite and local libSQL use the WAL
  checkpoint; remote libSQL uses an empty list.
- `isRetryable`: driver-specific busy/lock classifier, plus nested network codes
  for remote libSQL.
- `isDuplicateKey`: driver-specific duplicate-id classifier.

The SQL store reads these hooks. The core never imports `Dialect` and never
branches on a dialect name.

## Failure and drain behavior

- The default batch size is one. Larger batches use `Queue.takeBetween`; an
  optional interval uses a `Ref` buffer and a scoped timer, never a timeout
  around the take.
- A rejected batch is split in half. A duplicate single row is success; a
  non-duplicate single row is logged as lost. Split depth and total attempts are
  bounded per initial batch.
- Unacknowledged rows stay in a `Ref`; acknowledged sub-batches are removed.
- Shutdown interrupts consumers, flushes unacknowledged rows, the interval
  buffer, then the queue, with a two-second deadline per queue. Failures are
  logged and never throw.
