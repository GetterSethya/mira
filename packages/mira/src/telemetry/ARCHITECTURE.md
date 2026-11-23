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
`_telemetry_migrations`. A direct store append inside an application transaction
can be included in or rolled back with it; that is the documented trade-off that
makes shared mode work on PGlite and browser OPFS. The core's forked consumers
do not inherit the caller transaction.

## Transaction contract

A telemetry append is one `INSERT` with the dialect conflict clause, by default
`ON CONFLICT (<id>) DO NOTHING`. A duplicate id is a no-op, not an error. No
statement fails on a duplicate, and no recovery query runs after a failed
statement, so PostgreSQL cannot enter `25P02`.

A direct store append inside a caller transaction joins that transaction. A
commit writes the rows; a rollback removes them. This is the documented
trade-off that makes shared mode work on PGlite and browser OPFS. The telemetry
core runs its consumers in forked fibers, so a log emitted through the Effect
`Logger` does not inherit the caller transaction.

## Dialect hooks

`DialectType.telemetry` supplies:

- `setup`: connection statements for a dedicated connection. SQLite and local
  libSQL use WAL, `synchronous=NORMAL`, and a busy timeout; remote libSQL uses an
  empty list because sqld rejects writable pragmas.
- `cleanup`: statements after retention. SQLite and local libSQL use the WAL
  checkpoint; remote libSQL uses an empty list.
- `isRetryable`: driver-specific busy/lock classifier, plus nested network codes
  for remote libSQL.
- `insertConflictClause`: optional suffix for the batch insert. The store passes
  the quoted id column, for example `"id"`. Absent means
  `ON CONFLICT (<quoted id>) DO NOTHING`. A dialect that needs another form
  overrides it.

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
