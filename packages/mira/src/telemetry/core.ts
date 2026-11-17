import { Cause, Duration, Effect, Layer, Logger, Queue, Ref, Schema, Semaphore, Tracer } from "effect"
import { Base64Url } from "effect/encoding"

import { CryptoService } from "@/crypto/crypto.js"

import { formatPrettyLog, type LogLine } from "./logger.js"
import {
  type CompletedSpan,
  formatPrettySpan,
  makeConsoleTracer
} from "./tracer.js"
import {
  type TelemetryDuplicateEntryError,
  type TelemetryLogEntry,
  type TelemetrySpanEntry,
  TelemetryStore,
  type TelemetryStoreError
} from "./store.js"

const LOG_QUEUE_CAPACITY = 10_000
const DRAIN_TIMEOUT = "2 seconds"
const MAX_BATCH_SIZE = 1_000
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export interface TelemetryCoreConfig {
  /** Also print each log entry and span to stdout. Defaults to `false`. */
  readonly logConsole?: boolean
  /** When `logConsole` is enabled, print with Chalk coloring. Defaults to `false`. */
  readonly pretty?: boolean
  /** Maximum rows per store call. Defaults to `1`; clamped to `1..1_000`. */
  readonly flushBatchSize?: number
  /** Optional time-based flush for partially filled batches. */
  readonly flushInterval?: Duration.Input
}

type AppendError = TelemetryStoreError | TelemetryDuplicateEntryError

type Entry = { readonly id: string }

type AppendState<A extends Entry> = {
  readonly inFlight: Ref.Ref<ReadonlyArray<A>>
  readonly semaphore: Semaphore.Semaphore
  readonly append: (rows: ReadonlyArray<A>) => Effect.Effect<void, AppendError>
  readonly label: string
  readonly maxDepth: number
  readonly maxAttempts: number
}

const clampBatchSize = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.max(1, Math.min(MAX_BATCH_SIZE, Math.trunc(value)))
}

const intervalMillis = (value: Duration.Input | undefined): number => {
  if (value === undefined) return 0
  const millis = Duration.toMillis(Duration.fromInputUnsafe(value))
  return Number.isFinite(millis) && millis > 0 ? millis : 0
}

const logLost = (label: string, count: number) =>
  Effect.sync(() => {
    if (count > 0) console.error(`[telemetry] lost ${count} ${label} row${count === 1 ? "" : "s"}`)
  })

const appendWithRetry = <A extends Entry>(
  rows: ReadonlyArray<A>,
  state: AppendState<A>
): Effect.Effect<ReadonlyArray<A>> =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)

    const run = (current: ReadonlyArray<A>, depth: number): Effect.Effect<ReadonlyArray<A>> =>
      Effect.gen(function* () {
        if (current.length === 0) return []

        const used = yield* Ref.get(attempts)
        if (used >= state.maxAttempts || depth > state.maxDepth) {
          yield* Ref.set(state.inFlight, [])
          yield* logLost(state.label, current.length)
          return []
        }

        yield* Ref.update(attempts, (count) => count + 1)
        yield* Ref.set(state.inFlight, current)

        const outcome = yield* state.append(current).pipe(
          Effect.as({ ok: true as const }),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error }))
        )

        if (outcome.ok) {
          yield* Ref.set(state.inFlight, [])
          return current
        }

        if (outcome.error._tag === "TelemetryDuplicateEntryError" && current.length === 1) {
          yield* Ref.set(state.inFlight, [])
          return current
        }

        if (current.length === 1) {
          yield* Ref.set(state.inFlight, [])
          yield* logLost(state.label, 1)
          return []
        }

        const middle = Math.floor(current.length / 2)
        const left = yield* run(current.slice(0, middle), depth + 1)
        const right = yield* run(current.slice(middle), depth + 1)
        return [...left, ...right]
      })

    return yield* state.semaphore.withPermits(1)(run(rows, 0))
  })

type SpanIds = {
  readonly traceId: string
  readonly spanId: string
}

const makeLogEntry = (
  date: Date,
  span: SpanIds | undefined,
  level: string,
  message: unknown,
  randomBytesSync: (size: number) => Uint8Array
): TelemetryLogEntry => {
  const created = date.toISOString()
  return {
    id: Base64Url.encode(randomBytesSync(16)),
    level,
    message: String(Array.isArray(message) ? message.join(" ") : message),
    created,
    updated: created,
    traceId: span?.traceId ?? null,
    spanId: span?.spanId ?? null
  }
}

const echoLog = (entry: TelemetryLogEntry, pretty: boolean) =>
  Effect.sync(() => {
    const line: LogLine = {
      level: entry.level,
      message: entry.message,
      timestamp: entry.created
    }
    if (entry.traceId !== null) line.traceId = entry.traceId
    if (entry.spanId !== null) line.spanId = entry.spanId
    console.log(pretty ? formatPrettyLog(line) : encodeJson(line))
  })

const toSpanEntry = (
  span: CompletedSpan,
  randomBytesSync: (size: number) => Uint8Array
): TelemetrySpanEntry => {
  const created = new Date().toISOString()
  return {
    id: Base64Url.encode(randomBytesSync(16)),
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? null,
    kind: span.kind,
    durationMs: span.durationMs,
    status: span.status,
    error: span.error ?? null,
    attributes: span.attributes,
    created,
    updated: created
  }
}

const echoSpan = (entry: TelemetrySpanEntry, pretty: boolean) =>
  Effect.sync(() => {
    if (pretty) {
      const span: CompletedSpan = {
        name: entry.name,
        traceId: entry.traceId,
        spanId: entry.spanId,
        parentSpanId: entry.parentSpanId ?? undefined,
        kind: entry.kind,
        durationMs: entry.durationMs,
        status: entry.status,
        error: entry.error ?? undefined,
        attributes: { ...entry.attributes }
      }
      console.log(formatPrettySpan(span))
      return
    }

    const line: Record<string, unknown> = {
      span: entry.name,
      traceId: entry.traceId,
      spanId: entry.spanId,
      kind: entry.kind,
      durationMs: entry.durationMs,
      status: entry.status
    }
    if (Object.keys(entry.attributes).length > 0) line.attributes = entry.attributes
    if (entry.parentSpanId !== null) line.parentSpanId = entry.parentSpanId
    if (entry.error !== null) line.error = entry.error
    console.log(`[trace] ${encodeJson(line)}`)
  })

const startConsumer = <A>(
  queue: Queue.Queue<A>,
  batchSize: number,
  flushInterval: number,
  processBatch: (rows: ReadonlyArray<A>) => Effect.Effect<void>,
  flushInFlight: Effect.Effect<void>,
  label: string
) =>
  Effect.gen(function* () {
    const buffer = yield* Ref.make<ReadonlyArray<A>>([])

    const flushBuffer = Effect.gen(function* () {
      const rows = yield* Ref.modify(
        buffer,
        (current): readonly [ReadonlyArray<A>, ReadonlyArray<A>] => [current, []]
      )
      if (rows.length > 0) yield* processBatch(rows)
    })

    const drainQueue = Effect.gen(function* () {
      const rows = yield* Queue.clear(queue)
      for (let index = 0; index < rows.length; index += batchSize) {
        yield* processBatch(rows.slice(index, index + batchSize))
      }
    })

    const drain = Effect.gen(function* () {
      yield* flushInFlight
      yield* flushBuffer
      yield* drainQueue
    }).pipe(
      Effect.timeout(DRAIN_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error(`[telemetry] ${label} drain failed: ${Cause.pretty(cause)}`)
        })
      )
    )

    // Registered before the consumers, so consumers stop first (LIFO).
    yield* Effect.addFinalizer(() => drain)

    if (flushInterval > 0) {
      const enqueue = (row: A) =>
        Effect.gen(function* () {
          const current = yield* Ref.updateAndGet(buffer, (rows) => [...rows, row])
          if (current.length >= batchSize) yield* flushBuffer
        })

      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(queue).pipe(Effect.flatMap(enqueue))
        )
      )
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(Duration.millis(flushInterval)).pipe(Effect.andThen(flushBuffer))
        )
      )
      return
    }

    const takeBatch =
      batchSize === 1
        ? Queue.take(queue).pipe(Effect.map((row) => [row]))
        : Queue.takeBetween(queue, 1, batchSize)

    yield* Effect.forkScoped(
      Effect.forever(takeBatch.pipe(Effect.flatMap(processBatch)))
    )
  })

/**
 * Creates the SQL-free telemetry core.
 *
 * It requires only `TelemetryStore` and `CryptoService`; it has no `SqlClient`,
 * `Dialect`, or `Migrator` import. The returned layer provides only the Effect
 * logger and tracer, so the app keeps the store from `makeTelemetryLayer`.
 */
export function makeTelemetryLayerForClient(
  config: TelemetryCoreConfig = {}
): Layer.Layer<never, never, TelemetryStore | CryptoService> {
  const logConsole = config.logConsole ?? false
  const pretty = config.pretty ?? false
  const batchSize = clampBatchSize(config.flushBatchSize)
  const flushInterval = intervalMillis(config.flushInterval)
  const maxDepth = Math.ceil(Math.log2(batchSize)) + 1
  const maxAttempts = Math.max(8, 2 * Math.ceil(Math.log2(batchSize)) + 4)

  return Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* TelemetryStore
      const cryptoSvc = yield* CryptoService
      const randomBytesSync = (size: number) => cryptoSvc.randomBytesSync(size)

      const logQueue = yield* Queue.bounded<TelemetryLogEntry>(LOG_QUEUE_CAPACITY)
      const spanQueue = yield* Queue.unbounded<CompletedSpan>()
      let droppedLogs = 0

      const logger = Logger.make(({ date, fiber, logLevel, message }) => {
        const entry = makeLogEntry(
          date,
          fiber.cache.span,
          logLevel.toUpperCase(),
          message,
          randomBytesSync
        )
        if (!Queue.offerUnsafe(logQueue, entry)) droppedLogs += 1
      })

      const logInFlight = yield* Ref.make<ReadonlyArray<TelemetryLogEntry>>([])
      const spanInFlight = yield* Ref.make<ReadonlyArray<TelemetrySpanEntry>>([])
      const appendSemaphore = yield* Semaphore.make(1)

      const logState: AppendState<TelemetryLogEntry> = {
        inFlight: logInFlight,
        semaphore: appendSemaphore,
        append: (rows) => store.appendLogs(rows),
        label: "log",
        maxDepth,
        maxAttempts
      }

      const spanState: AppendState<TelemetrySpanEntry> = {
        inFlight: spanInFlight,
        semaphore: appendSemaphore,
        append: (rows) => store.appendSpans(rows),
        label: "span",
        maxDepth,
        maxAttempts
      }

      const flushLogInFlight = Effect.gen(function* () {
        const rows = yield* Ref.get(logInFlight)
        if (rows.length === 0) return
        const acked = yield* appendWithRetry(rows, logState)
        if (logConsole) yield* Effect.forEach(acked, (entry) => echoLog(entry, pretty), { discard: true })
      })

      const flushSpanInFlight = Effect.gen(function* () {
        const rows = yield* Ref.get(spanInFlight)
        if (rows.length === 0) return
        const acked = yield* appendWithRetry(rows, spanState)
        if (logConsole) yield* Effect.forEach(acked, (entry) => echoSpan(entry, pretty), { discard: true })
      })

      yield* startConsumer(
        logQueue,
        batchSize,
        flushInterval,
        (rows) =>
          Effect.gen(function* () {
            const acked = yield* appendWithRetry(rows, logState)
            if (logConsole) yield* Effect.forEach(acked, (entry) => echoLog(entry, pretty), { discard: true })
          }),
        flushLogInFlight,
        "log"
      )

      yield* startConsumer(
        spanQueue,
        batchSize,
        flushInterval,
        (rows) =>
          Effect.gen(function* () {
            const entries = rows.map((row) => toSpanEntry(row, randomBytesSync))
            const acked = yield* appendWithRetry(entries, spanState)
            if (logConsole) yield* Effect.forEach(acked, (entry) => echoSpan(entry, pretty), { discard: true })
          }),
        flushSpanInFlight,
        "span"
      )

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (droppedLogs > 0) console.error(`[telemetry] dropped ${droppedLogs} log rows`)
        })
      )

      const tracer = makeConsoleTracer(spanQueue, randomBytesSync)

      return Layer.merge(Logger.layer([logger]), Layer.succeed(Tracer.Tracer, tracer))
    })
  )
}
