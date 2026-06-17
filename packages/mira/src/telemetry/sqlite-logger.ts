import { Context, Effect, FiberRef, FiberRefs, Layer, Logger, Option, Queue, Schedule, Schema, Tracer } from "effect"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import type { CompletedSpan } from "./tracer.js"
import { makeConsoleTracer } from "./tracer.js"
import { CryptoService, NodeCryptoLayer } from "@/crypto/index.js"
import { TelemetrySqlClient } from "./telemetry-sql-client.js"
import { Migrator, MigratorLive, Dialect, sqliteDialect } from "@/migrator/index.js"
import { LogsCollection, SpansCollection } from "./collections.js"
import { AppConfig } from "@/config/index.js"
import type { CronDef } from "@/cron/types.js"

export interface SqliteLoggerConfig {
  /** Path to the SQLite log database. Defaults to `"mira-logs.db"`. */
  readonly dbPath?: string
  readonly logConsole?: boolean
}

const LogLineSchema = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
  created: Schema.String,
  traceId: Schema.optionalWith(Schema.String, { exact: true }),
  spanId: Schema.optionalWith(Schema.String, { exact: true })
})

const encodeLogLine = Schema.encodeSync(Schema.parseJson(LogLineSchema))

const SpanAttributeValueSchema = Schema.Union(Schema.String, Schema.Number, Schema.Boolean)

const SpanLineSchema = Schema.Struct({
  span: Schema.String,
  traceId: Schema.String,
  spanId: Schema.String,
  kind: Schema.String,
  durationMs: Schema.Number,
  status: Schema.Literal("ok", "error"),
  attributes: Schema.optionalWith(Schema.Record({ key: Schema.String, value: SpanAttributeValueSchema }), {
    exact: true
  }),
  parentSpanId: Schema.optionalWith(Schema.String, { exact: true }),
  error: Schema.optionalWith(Schema.String, { exact: true })
})

const encodeSpanLine = Schema.encode(Schema.parseJson(SpanLineSchema))
const encodeAttributes = Schema.encode(
  Schema.parseJson(Schema.Record({ key: Schema.String, value: SpanAttributeValueSchema }))
)

function makeSqliteLogger(
  sql: SqlClient.SqlClient,
  logConsole: boolean,
  randomBytesSync: (size: number) => Uint8Array
): Logger.Logger<unknown, void> {
  const sqlLayer = Layer.succeed(SqlClient.SqlClient, sql)

  return Logger.make(({ logLevel, message, date, context }) => {
    const ctx = FiberRefs.getOrDefault(context, FiberRef.currentContext)
    const spanOption = Context.getOption(ctx, Tracer.ParentSpan)

    const id = Buffer.from(randomBytesSync(16)).toString("base64url")
    const created = date.toISOString()

    const dbRow: {
      id: string
      level: string
      message: string
      created: string
      updated: string
      traceId?: string
      spanId?: string
    } = {
      id,
      level: logLevel.label,
      message: String(Array.isArray(message) ? message.join(" ") : message),
      created,
      updated: created
    }
    if (Option.isSome(spanOption)) {
      dbRow.traceId = spanOption.value.traceId
      dbRow.spanId = spanOption.value.spanId
    }

    Effect.runPromise(
      sql`INSERT INTO ${sql("logs")} ${sql.insert(dbRow)}`.pipe(Effect.provide(sqlLayer), Effect.orDie)
    ).catch(() => {})

    if (logConsole) {
      const consoleLine: {
        level: string
        message: string
        created: string
        traceId?: string
        spanId?: string
      } = {
        level: dbRow.level,
        message: dbRow.message,
        created: dbRow.created
      }
      if (dbRow.traceId !== undefined) consoleLine.traceId = dbRow.traceId
      if (dbRow.spanId !== undefined) consoleLine.spanId = dbRow.spanId
      console.log(encodeLogLine(consoleLine))
    }
  })
}

function writeSpanToDb(
  sql: SqlClient.SqlClient,
  span: CompletedSpan,
  logConsole: boolean,
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

    yield* sql`INSERT INTO ${sql("spans")} ${sql.insert(row)}`.pipe(Effect.provide(sqlLayer), Effect.orDie)

    if (logConsole) {
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
    }
  })
}

export const logCleanupCronDef: CronDef<TelemetrySqlClient | AppConfig> = {
  name: "mira:log-cleanup",
  description: "Delete logs and spans older than logRetentionDays days",
  schedule: Schedule.cron("0 0 * * *"),
  handler: () =>
    Effect.gen(function* () {
      const sql = yield* TelemetrySqlClient
      const config = yield* AppConfig
      const cutoff = new Date(Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000).toISOString()
      yield* sql`DELETE FROM ${sql("logs")} WHERE created < ${cutoff}`
      yield* sql`DELETE FROM ${sql("spans")} WHERE created < ${cutoff}`
      yield* Effect.logInfo(`[mira:log-cleanup] deleted logs and spans older than ${cutoff}`)
    })
}

/**
 * Creates a telemetry layer using the given `SqlClient.SqlClient` from context.
 * The caller is responsible for providing a SqlClient layer and a CryptoService layer.
 * Exported for testing — production code should use `makeSqliteTelemetryLayer`.
 */
export function makeSqliteTelemetryLayerForClient(
  config: Pick<SqliteLoggerConfig, "logConsole"> = {}
): Layer.Layer<never, never, SqlClient.SqlClient | CryptoService> {
  const logConsole = config.logConsole ?? false

  return Layer.unwrapScoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const cryptoSvc = yield* CryptoService
      const randomBytesSync = (size: number) => cryptoSvc.randomBytesSync(size)

      yield* Effect.gen(function* () {
        const migrator = yield* Migrator
        yield* migrator.migrate([
          { name: "logs", schema: LogsCollection.schema },
          { name: "spans", schema: SpansCollection.schema }
        ])
      }).pipe(
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

      const logger = makeSqliteLogger(sql, logConsole, randomBytesSync)
      const queue = yield* Queue.unbounded<CompletedSpan>()

      // Registered first → runs last (LIFO): drain items still in queue at shutdown.
      yield* Effect.addFinalizer(() =>
        Queue.takeAll(queue).pipe(
          Effect.flatMap(Effect.forEach((span) => writeSpanToDb(sql, span, logConsole, randomBytesSync))),
          Effect.asVoid
        )
      )

      // Registered second → runs first (LIFO): stop the consumer fiber.
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(queue).pipe(Effect.flatMap((span) => writeSpanToDb(sql, span, logConsole, randomBytesSync)))
        )
      )

      const tracer = makeConsoleTracer(queue, randomBytesSync)

      return Layer.merge(Logger.replace(Logger.defaultLogger, logger), Layer.setTracer(tracer))
    })
  )
}

/**
 * Creates a telemetry layer that writes structured log entries and span traces to
 * a dedicated SQLite database, separate from the main application database to
 * avoid contention on the primary connection.
 *
 * @param config.dbPath    Path to the log database file (default: `"mira-logs.db"`)
 * @param config.logConsole Also print each log entry and span as JSON to stdout
 */
export function makeSqliteTelemetryLayer(config: SqliteLoggerConfig = {}): Layer.Layer<never, never, never> {
  const ownSqlLayer = SqliteClient.layer({ filename: config.dbPath ?? "mira-logs.db" })
  const logConsole = config.logConsole ?? false

  // The logger/tracer layer requires SqlClient.SqlClient and CryptoService.
  const loggerLayer = makeSqliteTelemetryLayerForClient({ logConsole })

  // TelemetrySqlClient provides the same dedicated SqlClient to API routes.
  const telemetryClientLayer = Layer.effect(
    TelemetrySqlClient,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return sql
    })
  )

  return Layer.merge(loggerLayer, telemetryClientLayer).pipe(
    Layer.provide(ownSqlLayer),
    Layer.provide(NodeCryptoLayer),
    Layer.orDie
  )
}
