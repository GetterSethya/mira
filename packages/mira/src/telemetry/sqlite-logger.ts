import { Cause, Effect, Layer, Logger, Queue, Schedule, Schema, Tracer } from "effect"
import { SqlClient } from "effect/sql"

import { AppConfig } from "@/config/index.js"
import type { CronDef } from "@/cron/types.js"
import { CryptoService } from "@/crypto/crypto.js"
import { Dialect, Migrator, MigratorLive, sqliteDialect } from "@/migrator/index.js"

import { LogsCollection, SpansCollection } from "./collections.js"
import type { LogLine } from "./logger.js"
import { formatPrettyLog } from "./logger.js"
import { TelemetrySqlClient } from "./telemetry-sql-client.js"
import type { CompletedSpan } from "./tracer.js"
import { formatPrettySpan, makeConsoleTracer } from "./tracer.js"

export interface SqliteLoggerConfig {
  /**
   * SQL client layer for the dedicated telemetry database. The caller owns the
   * driver and the database file. Do not pass the application database layer.
   */
  readonly sqlLayer: Layer.Layer<SqlClient.SqlClient, never, never>
  /** Also print each log entry and span to stdout. Defaults to `false`. */
  readonly logConsole?: boolean
  /**
   * When `logConsole` is enabled, print with Chalk coloring instead of raw JSON.
   * Defaults to `false`.
   */
  readonly pretty?: boolean
}

const LOG_QUEUE_CAPACITY = 10_000
const LOG_DRAIN_TIMEOUT = "2 seconds"
const RETENTION_BATCH_SIZE = 1_000

type LogRow = {
  readonly id: string
  readonly level: string
  readonly message: string
  readonly created: string
  readonly updated: string
  readonly traceId?: string
  readonly spanId?: string
}

const LogLineSchema = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
  created: Schema.String,
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String)
})

const encodeLogLine = Schema.encodeSync(Schema.fromJsonString(LogLineSchema))

const SpanAttributeValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])

const SpanLineSchema = Schema.Struct({
  span: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  kind: Schema.String,
  durationMs: Schema.Number,
  status: Schema.Literals(["ok", "error"]),
  attributes: Schema.optionalKey(Schema.Record(Schema.String, SpanAttributeValueSchema)),
  parentSpanId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String)
})

const encodeSpanLine = Schema.encodeEffect(Schema.fromJsonString(SpanLineSchema))
const encodeAttributes = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, SpanAttributeValueSchema))
)

const isSqliteBusy = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false

  const reason = (error as {
    readonly reason?: {
      readonly _tag?: string
      readonly cause?: { readonly code?: string }
    }
  }).reason

  if (reason?._tag !== "LockTimeoutError") return false
  return reason.cause?.code === "SQLITE_BUSY" || reason.cause?.code === "SQLITE_LOCKED"
}

const migrationRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.upTo({ times: 4 })
)

function makeSqliteLogger(
  queue: Queue.Queue<LogRow>,
  randomBytesSync: (size: number) => Uint8Array,
  onDrop: () => void
): Logger.Logger<unknown, void> {
  return Logger.make(({ date, fiber, logLevel, message }) => {
    const span = fiber.cache.span
    const id = Buffer.from(randomBytesSync(16)).toString("base64url")
    const created = date.toISOString()

    const row: LogRow = {
      id,
      level: logLevel.toUpperCase(),
      message: String(Array.isArray(message) ? message.join(" ") : message),
      created,
      updated: created
    }

    if (span !== undefined) {
      const withSpan = { ...row, traceId: span.traceId, spanId: span.spanId }
      if (!Queue.offerUnsafe(queue, withSpan)) onDrop()
      return
    }

    if (!Queue.offerUnsafe(queue, row)) onDrop()
  })
}

function writeLogRow(
  sql: SqlClient.SqlClient,
  row: LogRow,
  logConsole: boolean,
  pretty: boolean
): Effect.Effect<void> {
  const sqlLayer = Layer.succeed(SqlClient.SqlClient, sql)

  return Effect.gen(function* () {
    yield* sql`INSERT INTO ${sql("logs")} ${sql.insert(row)}`.pipe(
      Effect.provide(sqlLayer),
      Effect.orDie
    )

    if (!logConsole) return

    if (pretty) {
      const prettyLine: LogLine = {
        level: row.level,
        message: row.message,
        timestamp: row.created
      }
      if (row.traceId !== undefined) prettyLine.traceId = row.traceId
      if (row.spanId !== undefined) prettyLine.spanId = row.spanId
      yield* Effect.sync(() => console.log(formatPrettyLog(prettyLine)))
      return
    }

    const consoleLine: {
      level: string
      message: string
      created: string
      traceId?: string
      spanId?: string
    } = {
      level: row.level,
      message: row.message,
      created: row.created
    }
    if (row.traceId !== undefined) consoleLine.traceId = row.traceId
    if (row.spanId !== undefined) consoleLine.spanId = row.spanId
    yield* Effect.sync(() => console.log(encodeLogLine(consoleLine)))
  })
}

function safeWriteLogRow(
  sql: SqlClient.SqlClient,
  row: LogRow,
  logConsole: boolean,
  pretty: boolean
): Effect.Effect<void> {
  return writeLogRow(sql, row, logConsole, pretty).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error(`[telemetry] log write failed: ${Cause.pretty(cause)}`)
      })
    )
  )
}

function writeSpanToDb(
  sql: SqlClient.SqlClient,
  span: CompletedSpan,
  logConsole: boolean,
  pretty: boolean,
  randomBytesSync: (size: number) => Uint8Array
): Effect.Effect<void> {
  const sqlLayer = Layer.succeed(SqlClient.SqlClient, sql)

  return Effect.gen(function* () {
    const attributesJson = yield* encodeAttributes(span.attributes).pipe(Effect.orDie)

    const id = Buffer.from(randomBytesSync(16)).toString("base64url")
    const created = new Date().toISOString()
    const row = {
      id,
      name: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId ?? null,
      kind: span.kind,
      durationMs: span.durationMs,
      status: span.status,
      error: span.error ?? null,
      attributes: attributesJson,
      created,
      updated: created
    }

    yield* sql`INSERT INTO ${sql("spans")} ${sql.insert(row)}`.pipe(
      Effect.provide(sqlLayer),
      Effect.orDie
    )

    if (!logConsole) return

    if (pretty) {
      yield* Effect.sync(() => console.log(formatPrettySpan(span)))
      return
    }

    const line: {
      span: string
      traceId: string
      spanId: string
      kind: string
      durationMs: number
      status: "ok" | "error"
      attributes?: Record<string, string | number | boolean>
      parentSpanId?: string
      error?: string
    } = {
      span: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      kind: span.kind,
      durationMs: span.durationMs,
      status: span.status
    }
    if (Object.keys(span.attributes).length > 0) line.attributes = span.attributes
    if (span.parentSpanId !== undefined) line.parentSpanId = span.parentSpanId
    if (span.error !== undefined) line.error = span.error

    yield* encodeSpanLine(line).pipe(
      Effect.orDie,
      Effect.flatMap((encoded) => Effect.sync(() => console.log(`[trace] ${encoded}`)))
    )
  })
}

function safeWriteSpanToDb(
  sql: SqlClient.SqlClient,
  span: CompletedSpan,
  logConsole: boolean,
  pretty: boolean,
  randomBytesSync: (size: number) => Uint8Array
): Effect.Effect<void> {
  return writeSpanToDb(sql, span, logConsole, pretty, randomBytesSync).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error(`[telemetry] span write failed: ${Cause.pretty(cause)}`)
      })
    )
  )
}

const drainRows = <A>(
  queue: Queue.Queue<A>,
  write: (value: A) => Effect.Effect<void>,
  label: string
): Effect.Effect<void> =>
  Queue.clear(queue).pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(rows, write, { concurrency: 1, discard: true })
    ),
    Effect.timeout(LOG_DRAIN_TIMEOUT),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.error(`[telemetry] ${label} drain failed: ${Cause.pretty(cause)}`)
      })
    ),
    Effect.asVoid
  )

const cleanupTable = (
  sql: SqlClient.SqlClient,
  table: "logs" | "spans",
  cutoff: string
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    for (;;) {
      const rows = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)} WHERE created < ${cutoff}`
      if (Number(rows[0]?.count ?? 0) === 0) return

      yield* sql`DELETE FROM ${sql(table)} WHERE seqId IN (SELECT seqId FROM ${sql(table)} WHERE created < ${cutoff} LIMIT ${RETENTION_BATCH_SIZE})`
    }
  })

export const logCleanupCronDef: CronDef<TelemetrySqlClient | AppConfig> = {
  name: "mira:log-cleanup",
  description: "Delete logs and spans older than logRetentionDays days",
  schedule: Schedule.cron("0 0 * * *"),
  handler: () =>
    Effect.gen(function* () {
      const sql = yield* TelemetrySqlClient
      const config = yield* AppConfig
      const cutoff = new Date(Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000).toISOString()

      yield* cleanupTable(sql, "logs", cutoff)
      yield* cleanupTable(sql, "spans", cutoff)

      const checkpoint = yield* sql<{ busy: number }>`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`[mira:log-cleanup] WAL checkpoint failed: ${Cause.pretty(cause)}`).pipe(
            Effect.as([] as Array<{ busy: number }>)
          )
        )
      )
      if (Number(checkpoint[0]?.busy ?? 0) !== 0) {
        yield* Effect.logWarning("[mira:log-cleanup] WAL checkpoint is busy")
      }

      yield* Effect.logInfo(`[mira:log-cleanup] deleted logs and spans older than ${cutoff}`)
    })
}

/**
 * Creates a telemetry layer using the given `SqlClient.SqlClient` from context.
 * The caller is responsible for providing a SqlClient layer and a CryptoService layer.
 * Exported for testing — production code should use `makeSqliteTelemetryLayer`.
 */
export function makeSqliteTelemetryLayerForClient(
  config: Pick<SqliteLoggerConfig, "logConsole" | "pretty"> = {}
): Layer.Layer<never, never, SqlClient.SqlClient | CryptoService> {
  const logConsole = config.logConsole ?? false
  const pretty = config.pretty ?? false

  return Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const cryptoSvc = yield* CryptoService
      const randomBytesSync = (size: number) => cryptoSvc.randomBytesSync(size)

      const migrate = Effect.gen(function* () {
        yield* sql`PRAGMA journal_mode = WAL`
        yield* sql`PRAGMA synchronous = NORMAL`
        yield* sql`PRAGMA busy_timeout = 5000`

        const migrator = yield* Migrator
        yield* migrator.migrate([
          { name: "logs", schema: LogsCollection.schema },
          { name: "spans", schema: SpansCollection.schema }
        ])
      }).pipe(
        Effect.retry({
          while: isSqliteBusy,
          schedule: migrationRetrySchedule
        })
      )

      yield* migrate.pipe(
        Effect.provide(
          Layer.mergeAll(
            MigratorLive.pipe(
              Layer.provide(
                //
                Layer.succeed(Dialect, sqliteDialect)
              )
            )
          ).pipe(
            Layer.provideMerge(
              //
              Layer.succeed(SqlClient.SqlClient, sql)
            )
          )
        ),
        Effect.orDie
      )

      const logQueue = yield* Queue.bounded<LogRow>(LOG_QUEUE_CAPACITY)
      const spanQueue = yield* Queue.unbounded<CompletedSpan>()
      let droppedLogs = 0

      const logger = makeSqliteLogger(logQueue, randomBytesSync, () => {
        droppedLogs += 1
      })

      // Registered first → runs last (LIFO): drain logs still in the queue.
      yield* Effect.addFinalizer(() =>
        drainRows(
          logQueue,
          (row) => safeWriteLogRow(sql, row, logConsole, pretty),
          "log"
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (droppedLogs > 0) {
                console.error(`[telemetry] dropped ${droppedLogs} log rows`)
              }
            })
          )
        )
      )

      // Registered second → runs after the log drain: drain spans still in the queue.
      yield* Effect.addFinalizer(() =>
        drainRows(
          spanQueue,
          (span) => safeWriteSpanToDb(sql, span, logConsole, pretty, randomBytesSync),
          "span"
        )
      )

      // Registered third/fourth → interrupted first, before the drain finalizers.
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(logQueue).pipe(
            Effect.flatMap((row) => safeWriteLogRow(sql, row, logConsole, pretty))
          )
        )
      )
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(spanQueue).pipe(
            Effect.flatMap((span) =>
              safeWriteSpanToDb(sql, span, logConsole, pretty, randomBytesSync)
            )
          )
        )
      )

      const tracer = makeConsoleTracer(spanQueue, randomBytesSync)

      return Layer.merge(Logger.layer([logger]), Layer.succeed(Tracer.Tracer, tracer))
    })
  )
}

/**
 * Creates a telemetry layer that writes structured log entries and span traces to
 * a dedicated SQL database. The caller supplies the SQL client layer, so this
 * module has no dependency on a specific SQLite driver.
 *
 * @param config.sqlLayer   SQL client layer for the dedicated telemetry database
 * @param config.logConsole Also print each log entry and span to stdout
 * @param config.pretty     When `logConsole` is enabled, print with Chalk coloring
 *                          instead of raw JSON (default: `false`)
 */
export function makeSqliteTelemetryLayer(
  config: SqliteLoggerConfig
): Layer.Layer<TelemetrySqlClient, never, CryptoService> {
  const logConsole = config.logConsole ?? false
  const pretty = config.pretty ?? false
  const loggerLayer = makeSqliteTelemetryLayerForClient({ logConsole, pretty })

  const telemetryClientLayer = Layer.effect(
    TelemetrySqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return sql
    })
  )

  return Layer.merge(loggerLayer, telemetryClientLayer).pipe(
    Layer.provide(config.sqlLayer),
    Layer.orDie
  )
}
