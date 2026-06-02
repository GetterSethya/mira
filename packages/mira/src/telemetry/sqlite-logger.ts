import { Context, Effect, FiberRef, FiberRefs, Layer, Logger, Option, Queue, Schema, Tracer } from "effect"
import { SqlClient } from "@effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-node"
import type { CompletedSpan } from "./tracer.js"
import { makeConsoleTracer } from "./tracer.js"
import { CryptoService, NodeCryptoLayer } from "@/crypto/index.js"

export interface SqliteLoggerConfig {
  /** Path to the SQLite log database. Defaults to `"mira-logs.db"`. */
  readonly dbPath?: string
  readonly logConsole?: boolean
}

const LogLineSchema = Schema.Struct({
  level: Schema.String,
  message: Schema.String,
  timestamp: Schema.String,
  traceId: Schema.optionalWith(Schema.String, { exact: true }),
  spanId: Schema.optionalWith(Schema.String, { exact: true }),
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
  attributes: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: SpanAttributeValueSchema }),
    { exact: true }
  ),
  parentSpanId: Schema.optionalWith(Schema.String, { exact: true }),
  error: Schema.optionalWith(Schema.String, { exact: true }),
})

const encodeSpanLine = Schema.encode(Schema.parseJson(SpanLineSchema))
const encodeAttributes = Schema.encode(
  Schema.parseJson(Schema.Record({ key: Schema.String, value: SpanAttributeValueSchema }))
)

function makeSqliteLogger(
  sql: SqlClient.SqlClient,
  logConsole: boolean
): Logger.Logger<unknown, void> {
  const sqlLayer = Layer.succeed(SqlClient.SqlClient, sql)

  return Logger.make(({ logLevel, message, date, context }) => {
    const ctx = FiberRefs.getOrDefault(context, FiberRef.currentContext)
    const spanOption = Context.getOption(ctx, Tracer.ParentSpan)

    const line: {
      level: string
      message: string
      timestamp: string
      traceId?: string
      spanId?: string
    } = {
      level: logLevel.label,
      message: String(Array.isArray(message) ? message.join(" ") : message),
      timestamp: date.toISOString(),
    }
    if (Option.isSome(spanOption)) {
      line.traceId = spanOption.value.traceId
      line.spanId = spanOption.value.spanId
    }

    Effect.runPromise(
      sql`INSERT INTO ${sql("logs")} ${sql.insert(line)}`.pipe(
        Effect.provide(sqlLayer),
        Effect.orDie
      )
    ).catch(() => {})

    if (logConsole) {
      console.log(encodeLogLine(line))
    }
  })
}

function writeSpanToDb(
  sql: SqlClient.SqlClient,
  span: CompletedSpan,
  logConsole: boolean
): Effect.Effect<void> {
  const sqlLayer = Layer.succeed(SqlClient.SqlClient, sql)

  return Effect.gen(function* () {
    const attributesJson = yield* encodeAttributes(span.attributes).pipe(Effect.orDie)

    const row = {
      name: span.name,
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId ?? null,
      kind: span.kind,
      durationMs: span.durationMs,
      status: span.status,
      error: span.error ?? null,
      attributes: attributesJson,
      timestamp: new Date().toISOString(),
    }

    yield* sql`INSERT INTO ${sql("spans")} ${sql.insert(row)}`.pipe(
      Effect.provide(sqlLayer),
      Effect.orDie
    )

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
        status: span.status,
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

      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS logs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        level     TEXT NOT NULL,
        message   TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        traceId   TEXT,
        spanId    TEXT
      )`).pipe(Effect.orDie)

      yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS spans (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL,
        traceId      TEXT NOT NULL,
        spanId       TEXT NOT NULL,
        parentSpanId TEXT,
        kind         TEXT NOT NULL,
        durationMs   REAL NOT NULL,
        status       TEXT NOT NULL,
        error        TEXT,
        attributes   TEXT NOT NULL,
        timestamp    TEXT NOT NULL
      )`).pipe(Effect.orDie)

      const logger = makeSqliteLogger(sql, logConsole)

      const queue = yield* Queue.unbounded<CompletedSpan>()

      // Registered first → runs last (LIFO): drain items still in queue at shutdown.
      yield* Effect.addFinalizer(() =>
        Queue.takeAll(queue).pipe(
          Effect.flatMap(Effect.forEach((span) => writeSpanToDb(sql, span, logConsole))),
          Effect.asVoid
        )
      )

      // Registered second → runs first (LIFO): stop the consumer fiber.
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(queue).pipe(Effect.flatMap((span) => writeSpanToDb(sql, span, logConsole)))
        )
      )

      const tracer = makeConsoleTracer(queue, (size) => cryptoSvc.randomBytesSync(size))

      return Layer.merge(
        Logger.replace(Logger.defaultLogger, logger),
        Layer.setTracer(tracer)
      )
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
export function makeSqliteTelemetryLayer(
  config: SqliteLoggerConfig = {}
): Layer.Layer<never, never, never> {
  const ownSqlLayer = SqliteClient.layer({ filename: config.dbPath ?? "mira-logs.db" })

  return makeSqliteTelemetryLayerForClient({ logConsole: config.logConsole ?? false }).pipe(
    Layer.provide(Layer.merge(ownSqlLayer, NodeCryptoLayer)),
    Layer.orDie
  )
}
