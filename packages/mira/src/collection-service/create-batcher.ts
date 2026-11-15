import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Ref, Result, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"

import type { RepoRecord } from "@/repository/types.js"

import type { CollectionError } from "./errors.js"
import {
  CreateBatchClosedError,
  CreateBatchNestedTransactionError,
  CreateBatchQueueFullError,
  CreateBatchTimeoutError
} from "./errors.js"

/**
 * Opt-in configuration for transparent server-side create batching.
 *
 * The batcher merges concurrent `CollectionService.create` inserts into one
 * SQLite transaction: each request still validates, checks rules and hashes
 * passwords in its own fiber, only the insert is queued and committed together.
 *
 * Batching is **off by default**. It trades a small fixed latency
 * (`windowMs`, `0` by default) at low concurrency for fewer commits (and
 * therefore fewer fsyncs) under load. It also widens the "row committed,
 * response not delivered" window, so a client that blindly retries a timed-out
 * create can duplicate a row — there is no idempotency key.
 *
 * @example
 * Mira.builder()
 *   // ... required steps
 *   .createBatch({ enabled: true, windowMs: 2, maxBatchSize: 100 })
 */
export interface MiraCreateBatchConfig {
  /** Master switch. Defaults to `false`. */
  readonly enabled?: boolean
  /**
   * How long the flusher waits for more entries after the first one. Defaults
   * to `0`, which drains what is already queued after one scheduler yield and
   * never sleeps. A positive value trades latency for larger batches, but note
   * that timer granularity applies (Windows rounds a 2 ms sleep up to ~15 ms).
   */
  readonly windowMs?: number
  /** Upper bound on records per flush (including the first entry). Defaults to `100`. */
  readonly maxBatchSize?: number
  /** Upper bound on queued entries. Defaults to `1_000`. */
  readonly maxQueueSize?: number
  /** Upper bound on queued payload bytes. Defaults to 32 MiB. */
  readonly maxQueueBytes?: number
  /** How long a request waits for its insert before failing with a 503. Defaults to `10_000`. */
  readonly submitTimeoutMs?: number
}

/**
 * A validated, fully-defaulted {@link MiraCreateBatchConfig}.
 *
 * Only produced when batching is enabled.
 */
export interface ResolvedCreateBatchConfig {
  readonly windowMs: number
  readonly maxBatchSize: number
  readonly maxQueueSize: number
  readonly maxQueueBytes: number
  readonly submitTimeoutMs: number
}

const DEFAULT_WINDOW_MS = 0
const DEFAULT_MAX_BATCH_SIZE = 100
const DEFAULT_MAX_QUEUE_SIZE = 1_000
const DEFAULT_MAX_QUEUE_BYTES = 32 * 1024 * 1024
const DEFAULT_SUBMIT_TIMEOUT_MS = 10_000

function resolveInteger(field: string, value: number | undefined, fallback: number, min: number) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min) {
    // Startup configuration validation, not Effect business logic — a plain
    // thrown Error is the contract here (matching `assertValidCorsConfig`).
    throw new Error(`MiraCreateBatchConfig.${field} must be an integer >= ${min} (received ${String(value)})`)
  }
  return value
}

/**
 * `windowMs` accepts fractional milliseconds (`0.5` is meaningful and appears
 * in the audit's window sweep); every other value is an integer.
 */
function resolveWindowMs(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `MiraCreateBatchConfig.windowMs must be a finite number >= 0 (received ${String(value)})`
    )
  }
  return value
}

/**
 * Validate a {@link MiraCreateBatchConfig} and fill in defaults.
 *
 * Returns `null` when batching is not explicitly enabled, so callers can
 * branch on a single value. Invalid values throw at startup, before any server
 * is bound.
 *
 * @example
 * resolveCreateBatchConfig({ enabled: true })  // => { windowMs: 2, maxBatchSize: 100, ... }
 * resolveCreateBatchConfig({ enabled: false }) // => null
 */
export function resolveCreateBatchConfig(config?: MiraCreateBatchConfig): ResolvedCreateBatchConfig | null {
  if (config?.enabled !== true) return null
  return {
    windowMs: resolveWindowMs(config.windowMs, DEFAULT_WINDOW_MS),
    maxBatchSize: resolveInteger("maxBatchSize", config.maxBatchSize, DEFAULT_MAX_BATCH_SIZE, 1),
    maxQueueSize: resolveInteger("maxQueueSize", config.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 1),
    maxQueueBytes: resolveInteger("maxQueueBytes", config.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, 1),
    submitTimeoutMs: resolveInteger("submitTimeoutMs", config.submitTimeoutMs, DEFAULT_SUBMIT_TIMEOUT_MS, 1)
  }
}

const ESTIMATE_DEPTH_LIMIT = 32
const ESTIMATE_CEILING = 1 << 30

/**
 * Budget estimate for a prepared row, in bytes. Not an exact allocation size:
 * strings count UTF-16 length × 2, numbers 8, booleans 1, `null`/`undefined` 0,
 * `Uint8Array` its byte length, arrays the sum of their items plus 8 bytes, and
 * plain objects their key lengths plus values plus 16 bytes.
 *
 * The estimator short-circuits at 1 GiB and stops descending past 32 levels so
 * a hostile payload cannot blow the stack; it is a queue budget, not a
 * serializer.
 */
export function estimateRowBytes(value: unknown): number {
  return estimateBytes(value, 0)
}

function estimateBytes(value: unknown, depth: number): number {
  if (value === null || value === undefined) return 0
  if (typeof value === "string") return value.length * 2
  if (typeof value === "number") return 8
  if (typeof value === "boolean") return 1
  if (typeof value === "bigint") return 8
  if (depth >= ESTIMATE_DEPTH_LIMIT) return 0
  if (value instanceof Uint8Array) return value.byteLength
  if (Array.isArray(value)) {
    let total = 8
    for (const item of value) {
      total += estimateBytes(item, depth + 1)
      if (total >= ESTIMATE_CEILING) return ESTIMATE_CEILING
    }
    return total
  }
  if (typeof value === "object") {
    let total = 16
    for (const [key, item] of Object.entries(value)) {
      total += key.length * 2 + estimateBytes(item, depth + 1)
      if (total >= ESTIMATE_CEILING) return ESTIMATE_CEILING
    }
    return total
  }
  return 0
}

/**
 * A create whose request-specific work (validation, rules, credentials,
 * password hashing, boolean encoding) is already done. `row` must not be
 * mutated after preparation: it is shared with the flusher fiber.
 *
 * `admin` is captured per entry so hidden-field stripping never becomes a
 * batch-wide decision.
 */
export interface PreparedCreate {
  readonly collection: AnyCollectionDef
  /** Already password-hashed and dialect-encoded. */
  readonly row: RepoRecord
  readonly admin: boolean
}

/**
 * One unit of batched work. `insert` closes over the collection-service
 * layer's repository/decoder/strip helpers, so it requires no services and can
 * never re-resolve a different `SqlClient`.
 */
export interface CreateBatchEntry {
  readonly collection: AnyCollectionDef
  readonly insert: Effect.Effect<RepoRecord, CollectionError>
  readonly estimatedBytes: number
}

interface QueuedEntry {
  readonly collection: AnyCollectionDef
  readonly insert: Effect.Effect<RepoRecord, CollectionError>
  readonly deferred: Deferred.Deferred<RepoRecord, CollectionError>
  readonly cancelled: Ref.Ref<boolean>
  readonly bytes: number
}

type EntryOutcome =
  | { readonly _tag: "success"; readonly entry: QueuedEntry; readonly row: RepoRecord }
  | { readonly _tag: "failure"; readonly entry: QueuedEntry; readonly error: CollectionError }
  | { readonly _tag: "skipped"; readonly entry: QueuedEntry }

/**
 * The service that runs an already-prepared create insert. Always present:
 * `CreateBatcherDisabledLive` runs the insert inline (today's behaviour), the
 * real layer queues it for the shared flusher.
 */
export class CreateBatcher extends Context.Service<
  CreateBatcher,
  {
    submit(entry: CreateBatchEntry): Effect.Effect<RepoRecord, CollectionError>
  }
>()("mira/CreateBatcher") {}

/**
 * Snapshot of batcher counters. `commits` is recorded at the transaction
 * chokepoint (after `COMMIT` returns), never derived from `batches`.
 */
export interface CreateBatchStatsSnapshot {
  readonly batches: number
  readonly commits: number
  /** Rows actually written (successful inserts only; skipped/cancelled entries do not count). */
  readonly records: number
  readonly maxBatchSize: number
  /** Sizes of the last 50 flushes, not the whole run. */
  readonly lastBatchSizes: ReadonlyArray<number>
  readonly rejected: number
  readonly consecutiveDefects: number
  /** Entries that waited past `submitTimeoutMs` and were given up on. */
  readonly timedOut: number
  /** Entries admitted since the last `reset` (deterministic test/benchmark seam). */
  readonly admitted: number
}

/**
 * Observable counters plus the explicit flush trigger used by tests and the
 * benchmark. One instance per app build (layer memoization): the app provides
 * it to the batcher and exposes it to plugin routes.
 */
export class CreateBatchStats extends Context.Service<
  CreateBatchStats,
  {
    readonly flushSignal: Queue.Dequeue<void>
    readonly snapshot: Effect.Effect<CreateBatchStatsSnapshot>
    readonly reset: Effect.Effect<void>
    /** Called at the transaction chokepoint, after `COMMIT` returns. */
    readonly recordCommit: Effect.Effect<void>
    /**
     * @param size - entries in the flush (including skipped/cancelled ones)
     * @param written - rows actually inserted (successful entries only)
     * @param collections - distinct collection names in the flush
     */
    readonly recordFlush: (
      size: number,
      written: number,
      collections: ReadonlyArray<string>
    ) => Effect.Effect<void>
    readonly recordRejected: Effect.Effect<void>
    readonly recordDefect: Effect.Effect<void>
    readonly recordTimeout: Effect.Effect<void>
    /** Called by the batcher when an entry is admitted to the queue. */
    readonly recordAdmitted: Effect.Effect<void>
    /** Release a waiting flush immediately instead of waiting out `windowMs`. */
    readonly flushNow: Effect.Effect<void>
  }
>()("mira/CreateBatchStats") {}

interface StatsState {
  readonly batches: number
  readonly commits: number
  readonly records: number
  readonly maxBatchSize: number
  readonly lastBatchSizes: ReadonlyArray<number>
  readonly rejected: number
  readonly consecutiveDefects: number
  readonly timedOut: number
  readonly admitted: number
}

const initialStatsState: StatsState = {
  batches: 0,
  commits: 0,
  records: 0,
  maxBatchSize: 0,
  lastBatchSizes: [],
  rejected: 0,
  consecutiveDefects: 0,
  timedOut: 0,
  admitted: 0
}

const LAST_BATCH_SIZES = 50

/**
 * Create the single stats service value for an app build.
 *
 * The caller must merge this exact layer value into the service layer and pass
 * it to `makeCreateBatcherLayer`/`makeCachedCollectionServiceLayer` so layer
 * memoization yields one instance.
 */
export function makeCreateBatchStatsLayer(): Layer.Layer<CreateBatchStats> {
  return Layer.effect(
    CreateBatchStats,
    Effect.gen(function* () {
      const state = yield* Ref.make(initialStatsState)
      // Sliding(1): `flushNow` is a nudge, not a work queue. Repeated offers
      // never accumulate when nothing is waiting (e.g. the default zero window
      // never takes the signal).
      const flushSignal = yield* Queue.sliding<void>(1)

      return CreateBatchStats.of({
        flushSignal,
        snapshot: Effect.map(Ref.get(state), (current) => ({
          batches: current.batches,
          commits: current.commits,
          records: current.records,
          maxBatchSize: current.maxBatchSize,
          lastBatchSizes: current.lastBatchSizes,
          rejected: current.rejected,
          consecutiveDefects: current.consecutiveDefects,
          timedOut: current.timedOut,
          admitted: current.admitted
        })),
        reset: Ref.set(state, initialStatsState),
        recordCommit: Ref.update(state, (current) => ({ ...current, commits: current.commits + 1 })),
        recordFlush: (size, written, _collections) =>
          Ref.update(state, (current) => ({
            ...current,
            batches: current.batches + 1,
            records: current.records + written,
            maxBatchSize: Math.max(current.maxBatchSize, size),
            lastBatchSizes: [...current.lastBatchSizes, size].slice(-LAST_BATCH_SIZES),
            consecutiveDefects: 0
          })),
        recordRejected: Ref.update(state, (current) => ({ ...current, rejected: current.rejected + 1 })),
        recordDefect: Ref.update(state, (current) => ({
          ...current,
          consecutiveDefects: current.consecutiveDefects + 1
        })),
        recordTimeout: Ref.update(state, (current) => ({ ...current, timedOut: current.timedOut + 1 })),
        recordAdmitted: Ref.update(state, (current) => ({ ...current, admitted: current.admitted + 1 })),
        flushNow: Queue.offer(flushSignal, undefined).pipe(Effect.asVoid)
      })
    })
  )
}

/**
 * Batcher used when create batching is disabled: run the insert inline, record
 * one commit, create no queue and fork no fiber. This is the pre-spike
 * behaviour, byte for byte.
 */
export const CreateBatcherDisabledLive: Layer.Layer<CreateBatcher> = Layer.effect(
  CreateBatcher,
  Effect.succeed(
    CreateBatcher.of({
      submit: (entry) =>
        Effect.gen(function* () {
          const row = yield* entry.insert
          // Resolve the optional stats layer at run time: the disabled batcher
          // must not require it, but the app supplies one for observability.
          yield* Effect.serviceOption(CreateBatchStats).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (stats) => stats.recordCommit
              })
            )
          )
          return row
        })
    })
  )
)

const MAX_COLLECTIONS_ATTRIBUTE = 256

function collectionErrorOf(
  cause: Cause.Cause<CollectionError | SqlError.SqlError>,
  pending: number
): CollectionError {
  const typed = Cause.findFail(cause)
  if (Result.isSuccess(typed)) return typed.success.error
  // Defect-only causes come from the driver's transaction bookkeeping (a
  // failed `COMMIT`, for example, is raised with `Effect.orDie`). The batch is
  // unusable either way: report it as closed rather than inventing a 500.
  return new CreateBatchClosedError({ pending })
}

/**
 * Probe whether the current SQL transaction is still usable.
 *
 * `SELECT 1` catches a dead connection. SQLite's implicit rollbacks
 * (`SQLITE_FULL`, `ON CONFLICT ROLLBACK`, `RAISE(ROLLBACK)`) leave the
 * connection in autocommit, where `SELECT 1` still succeeds — so a second
 * probe distinguishes the two states: `BEGIN` fails with "cannot start a
 * transaction within a transaction" while the outer transaction is alive, and
 * succeeds (starting a throwaway transaction) once SQLite has rolled it back.
 * A successful probe is undone with `ROLLBACK`.
 *
 * Exported for the focused probe tests.
 *
 * @internal
 */
export const probeTransactionAlive = (
  sql: SqlClient.SqlClient
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const select = yield* Effect.exit(sql`SELECT 1 AS ok`)
    if (Exit.isFailure(select)) return false
    const begin = yield* Effect.exit(sql`${sql.literal("BEGIN")}`)
    if (Exit.isFailure(begin)) return true
    yield* Effect.exit(sql`${sql.literal("ROLLBACK")}`)
    return false
  })

/**
 * Wait for more entries before draining a partially filled batch.
 *
 * `windowMs === 0` is the default and is a deliberate special case: it yields
 * once so concurrently queued inserts can join, and never calls `Effect.sleep`.
 * A positive sleep is a real timer; on Windows the timer granularity rounds a
 * 2 ms window up to ~15.6 ms, which made every sequential (c1) create 7× slower
 * than the inline path. Positive windows still sleep for callers that want to
 * trade latency for larger batches.
 */
const waitForWindow = (windowMs: number, flushSignal: Queue.Dequeue<void>): Effect.Effect<void> =>
  windowMs === 0
    ? Effect.yieldNow
    : Effect.race(Effect.sleep(windowMs), Queue.take(flushSignal)).pipe(Effect.asVoid)

/**
 * Create the real batching layer.
 *
 * One queue and one flusher fiber per layer instance (and therefore per app
 * build). The returned layer is scoped: closing its scope performs the ordered
 * shutdown (mark closed → interrupt flusher → fail queued/in-flight entries →
 * shut the queue) before the SQL client is released.
 *
 * @param config - A resolved (validated) configuration
 * @param statsLayer - The app's single `CreateBatchStats` layer value
 */
export function makeCreateBatcherLayer(
  config: ResolvedCreateBatchConfig,
  statsLayer: Layer.Layer<CreateBatchStats>
): Layer.Layer<CreateBatcher, never, SqlClient.SqlClient> {
  return Layer.effect(
    CreateBatcher,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const stats = yield* CreateBatchStats

      const queue = yield* Queue.unbounded<QueuedEntry>()
      const closed = yield* Ref.make(false)
      const capacity = yield* Ref.make<{ readonly count: number; readonly bytes: number }>({
        count: 0,
        bytes: 0
      })
      const inFlight = yield* Ref.make<ReadonlyArray<QueuedEntry>>([])

      // Serializes admission against shutdown/degradation: an entry can never
      // be admitted while the finalizer is draining, so every admitted entry
      // has an owner. Both critical sections are short and synchronous.
      const lifecycle = yield* Semaphore.make(1)

      const pendingCount = Ref.get(capacity).pipe(Effect.map((current) => current.count))

      const release = (entries: ReadonlyArray<QueuedEntry>) =>
        Ref.update(capacity, (current) => ({
          count: Math.max(0, current.count - entries.length),
          bytes: Math.max(0, current.bytes - entries.reduce((total, entry) => total + entry.bytes, 0))
        }))

      const close = Ref.set(closed, true)

      /**
       * Stats are observability, never part of the HTTP contract: a counter
       * failure is logged and swallowed.
       */
      const ignoreStats = (stage: string) => (cause: Cause.Cause<unknown>) =>
        Effect.logWarning("create-batch.stats_failed", { stage, cause: Cause.pretty(cause) })

      const failEntries = (entries: ReadonlyArray<QueuedEntry>, error: CollectionError) =>
        Effect.forEach(entries, (entry) => Deferred.fail(entry.deferred, error), { concurrency: 1 })

      const drainQueue: Effect.Effect<ReadonlyArray<QueuedEntry>> = Effect.gen(function* () {
        const size = yield* Queue.size(queue)
        if (size === 0) return []
        const drained = yield* Queue.takeN(queue, size)
        yield* release(drained)
        return drained
      })

      /** Fail everything still queued, releasing its budget. */
      const failQueue = (makeError: (pending: number) => CollectionError) =>
        Effect.gen(function* () {
          const drained = yield* drainQueue
          yield* failEntries(drained, makeError(drained.length))
          return drained.length
        })

      /**
       * Fail every not-yet-settled deferred of a batch. `Deferred.fail` is a
       * no-op for entries already completed, so this is safe to run after the
       * per-entry settlement and on interruption.
       */
      const failRemaining = (entries: ReadonlyArray<QueuedEntry>, error: CollectionError) =>
        failEntries(entries, error)

      const settle = (
        entries: ReadonlyArray<QueuedEntry>,
        outcomes: Ref.Ref<ReadonlyArray<EntryOutcome>>,
        exit: Exit.Exit<void, CollectionError | SqlError.SqlError>,
        aborted: Ref.Ref<Option.Option<CollectionError>>
      ) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) {
            const settled = yield* Ref.get(outcomes)
            // Deferreds FIRST: the rows are committed, so each request's HTTP
            // outcome must not depend on a counter. Stats are best-effort and
            // run afterwards.
            for (const outcome of settled) {
              if (outcome._tag === "success") {
                yield* Deferred.succeed(outcome.entry.deferred, outcome.row)
              } else if (outcome._tag === "failure") {
                yield* Deferred.fail(outcome.entry.deferred, outcome.error)
              } else {
                yield* Deferred.interrupt(outcome.entry.deferred)
              }
            }

            const written = settled.filter((outcome) => outcome._tag === "success").length
            const collections = [...new Set(entries.map((entry) => entry.collection.name))]
            yield* stats.recordCommit.pipe(Effect.catchCause(ignoreStats("commit")))
            yield* stats
              .recordFlush(entries.length, written, collections)
              .pipe(Effect.catchCause(ignoreStats("flush")))
            return
          }

          const pending = entries.length
          const isClosed = yield* Ref.get(closed)
          const abortCause = yield* Ref.get(aborted)
          const error = Option.isSome(abortCause)
            ? abortCause.value
            : Cause.hasInterruptsOnly(exit.cause) || isClosed
              ? new CreateBatchClosedError({ pending })
              : collectionErrorOf(exit.cause, pending)
          yield* failRemaining(entries, error)
        }).pipe(Effect.uninterruptible)

      const runBatchBody = (
        taken: ReadonlyArray<QueuedEntry>,
        outcomes: Ref.Ref<ReadonlyArray<EntryOutcome>>,
        aborted: Ref.Ref<Option.Option<CollectionError>>
      ) =>
        Effect.gen(function* () {
          const settled: Array<EntryOutcome> = []
          for (const [index, entry] of taken.entries()) {
            if (yield* Ref.get(entry.cancelled)) {
              settled.push({ _tag: "skipped", entry })
              continue
            }

            // Capture this entry's own failure cause *before* the driver's
            // savepoint finalizer runs: when a transaction-fatal error has
            // already rolled the savepoint back, `ROLLBACK TO SAVEPOINT` dies
            // and would otherwise replace the real error with a defect.
            const observed = yield* Ref.make<Option.Option<Cause.Cause<CollectionError>>>(Option.none())
            const insert = entry.insert.pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Ref.set(observed, Option.some(exit.cause)) : Effect.void
              ),
              Effect.withSpan(
                "collection.insertInBatch",
                {
                  kind: "internal",
                  attributes: { "batch.index": index, collection: entry.collection.name }
                },
                { captureStackTrace: false }
              )
            )

            // One insert never needs a savepoint: the outer transaction rolls
            // it back anyway, and this is the low-concurrency path.
            const guarded = taken.length === 1 ? insert : sql.withTransaction(insert)
            const result = yield* Effect.exit(guarded)

            if (Exit.isSuccess(result)) {
              settled.push({ _tag: "success", entry, row: result.value })
              continue
            }

            if (Cause.hasInterruptsOnly(result.cause)) {
              yield* Ref.set(outcomes, settled)
              return yield* Effect.failCause(result.cause)
            }

            const originalCause = Option.getOrElse(yield* Ref.get(observed), () => result.cause)

            const alive = yield* probeTransactionAlive(sql)
            if (!alive) {
              // Transaction-fatal: every entry in the batch fails with the
              // entry's own cause, and the commit is skipped.
              yield* Ref.set(aborted, Option.some(collectionErrorOf(originalCause, taken.length)))
              yield* Ref.set(outcomes, settled)
              return yield* Effect.failCause(result.cause)
            }

            // Statement-level: only this savepoint rolled back; the rest of the
            // batch still commits.
            settled.push({ _tag: "failure", entry, error: collectionErrorOf(originalCause, taken.length) })
          }
          yield* Ref.set(outcomes, settled)
        })

      const flushOnce = Effect.gen(function* () {
        // Atomic take + publish: an interrupt must not land after the queue
        // hands over the entry but before `inFlight` owns it, or shutdown
        // cannot fail it.
        const first = yield* Effect.uninterruptibleMask((restore) =>
          restore(Queue.take(queue)).pipe(
            Effect.flatMap((entry) => Ref.set(inFlight, [entry]).pipe(Effect.as(entry)))
          )
        )
        const taken: Array<QueuedEntry> = [first]

        const remaining = config.maxBatchSize - 1
        // Drain what is already queued; only wait when the batch is still
        // below the cap.
        if ((yield* Queue.size(queue)) < remaining) {
          yield* waitForWindow(config.windowMs, stats.flushSignal)
        }

        const size = yield* Queue.size(queue)
        if (size > 0) {
          const more = yield* Queue.takeN(queue, Math.min(size, config.maxBatchSize - taken.length))
          taken.push(...more)
        }
        yield* Ref.set(inFlight, taken)
        yield* release(taken)

        const outcomes = yield* Ref.make<ReadonlyArray<EntryOutcome>>([])
        const aborted = yield* Ref.make<Option.Option<CollectionError>>(Option.none())
        const collections = [...new Set(taken.map((entry) => entry.collection.name))]

        yield* sql.withTransaction(runBatchBody(taken, outcomes, aborted)).pipe(
          Effect.withSpan(
            "collection.createBatch",
            {
              kind: "internal",
              attributes: {
                "batch.size": taken.length,
                "batch.collectionCount": collections.length,
                "batch.collections": collections.join(",").slice(0, MAX_COLLECTIONS_ATTRIBUTE)
              }
            },
            { captureStackTrace: false }
          ),
          // `onExit` sits outside `sql.withTransaction`, so a failed COMMIT is
          // observed as a failure and every entry is settled exactly once.
          // Settlement — including the post-commit success path — is
          // uninterruptible: once COMMIT returned the row exists.
          Effect.onExit((exit) => settle(taken, outcomes, exit, aborted))
        )

        yield* Ref.set(inFlight, [])
      }).pipe(
        // Safety net for the window/drain phase: interruption before the
        // transaction opens (or a defect before settlement) must not leave a
        // deferred unresolved.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.uninterruptible(
                Effect.gen(function* () {
                  const entries = yield* Ref.get(inFlight)
                  const isClosed = yield* Ref.get(closed)
                  yield* failRemaining(
                    entries,
                    isClosed
                      ? new CreateBatchClosedError({ pending: entries.length })
                      : collectionErrorOf(exit.cause, entries.length)
                  )
                  yield* Ref.set(inFlight, [])
                })
              )
        )
      )

      /** Close, fail everything queued, and stop accepting work. */
      const closeAndFailQueue = (defects: number) =>
        Effect.gen(function* () {
          yield* close
          const pending = yield* failQueue((count) => new CreateBatchClosedError({ pending: count }))
          yield* Effect.logError("create-batch.degraded", {
            consecutiveDefects: defects,
            pending
          })
        }).pipe(Effect.ensuring(Queue.shutdown(queue).pipe(Effect.catchCause(() => Effect.void))))

      const degraded = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          yield* Effect.logError("create-batch.flush_defect", { cause: Cause.pretty(cause) })
          yield* stats.recordDefect.pipe(Effect.catchCause(() => Effect.void))
          const snapshot = yield* stats.snapshot
          if (snapshot.consecutiveDefects < 3) return
          yield* lifecycle.withPermit(closeAndFailQueue(snapshot.consecutiveDefects))
          // End the flusher instead of hot-looping for the life of the
          // process. New submissions already fail fast with Closed.
          yield* Effect.interrupt
        }).pipe(
          // A failure while degrading must still close the batcher and end the
          // loop; otherwise every later create waits for `submitTimeoutMs`.
          Effect.catchCause((failure) =>
            Effect.gen(function* () {
              yield* Effect.logError("create-batch.degraded_failed", {
                cause: Cause.pretty(failure)
              }).pipe(Effect.catchCause(() => Effect.void))
              yield* lifecycle
                .withPermit(
                  close.pipe(
                    Effect.andThen(Queue.shutdown(queue).pipe(Effect.catchCause(() => Effect.void)))
                  )
                )
                .pipe(Effect.catchCause(() => Effect.void))
              yield* Effect.interrupt
            })
          )
        )

      const loop = Effect.forever(
        flushOnce.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : degraded(cause)
          )
        )
      )

      const flusher = yield* Effect.forkScoped(loop)

      yield* Effect.addFinalizer(() =>
        Effect.uninterruptible(
          lifecycle.withPermit(
            Effect.gen(function* () {
              // 1. New submissions fail fast, and the flusher's exit handler
              //    knows to report `CreateBatchClosedError`.
              yield* close
              // 2. Interrupt the flusher and wait for it. Its transaction body
              //    is interruptible, so an in-flight transaction rolls back;
              //    the post-commit segment is uninterruptible and still
              //    succeeds.
              yield* Fiber.interrupt(flusher)
              // 3. Fail whatever is still waiting (queue + in-flight).
              const pending = yield* failQueue((count) => new CreateBatchClosedError({ pending: count }))
              const remaining = yield* Ref.get(inFlight)
              yield* failRemaining(
                remaining,
                new CreateBatchClosedError({ pending: pending + remaining.length })
              )
              yield* Ref.set(inFlight, [])
              // 4. Stop blocked internal operations, then let the scope release
              //    downstream services.
              yield* Queue.shutdown(queue)
            })
          )
        )
      )

      return CreateBatcher.of({
        submit: (entry) =>
          Effect.gen(function* () {
            // Calling contract: `create` must not run in a fiber that already
            // holds the SQL transaction connection. The flusher could never
            // acquire it, so fail fast instead of deadlocking.
            const context = yield* Effect.context()
            if (Option.isSome(Context.getOption(context, sql.transactionService))) {
              return yield* Effect.fail(new CreateBatchNestedTransactionError())
            }

            // A single row larger than the whole byte budget can never be
            // admitted: fail fast instead of clamping it into the queue.
            if (entry.estimatedBytes > config.maxQueueBytes) {
              yield* stats.recordRejected.pipe(Effect.catchCause(ignoreStats("rejected")))
              return yield* Effect.fail(
                new CreateBatchQueueFullError({ limit: config.maxQueueBytes })
              )
            }

            const bytes = Math.max(0, entry.estimatedBytes)
            const deferred = yield* Deferred.make<RepoRecord, CollectionError>()
            const cancelled = yield* Ref.make(false)
            const queued: QueuedEntry = {
              collection: entry.collection,
              insert: entry.insert,
              deferred,
              cancelled,
              bytes
            }

            // Admission and the offer happen under the lifecycle lock so the
            // shutdown finalizer cannot drain between them.
            const admission = yield* lifecycle.withPermit(
              Effect.gen(function* () {
                if (yield* Ref.get(closed)) return "closed" as const
                const decision = yield* Ref.modify(capacity, (current) => {
                  if (current.count >= config.maxQueueSize) return ["count" as const, current] as const
                  if (current.bytes + bytes > config.maxQueueBytes) {
                    return ["bytes" as const, current] as const
                  }
                  return [
                    "ok" as const,
                    { count: current.count + 1, bytes: current.bytes + bytes }
                  ] as const
                })
                if (decision !== "ok") return decision
                const offered = yield* Queue.offer(queue, queued)
                if (!offered) {
                  yield* release([queued])
                  return "closed" as const
                }
                yield* stats.recordAdmitted.pipe(Effect.catchCause(ignoreStats("admitted")))
                return "admitted" as const
              })
            )

            if (admission === "closed") {
              return yield* Effect.fail(new CreateBatchClosedError({ pending: yield* pendingCount }))
            }
            if (admission !== "admitted") {
              yield* stats.recordRejected.pipe(Effect.catchCause(ignoreStats("rejected")))
              return yield* Effect.fail(
                new CreateBatchQueueFullError({
                  limit: admission === "bytes" ? config.maxQueueBytes : config.maxQueueSize
                })
              )
            }

            return yield* Deferred.await(queued.deferred).pipe(
              Effect.timeoutOption(config.submitTimeoutMs),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Ref.set(queued.cancelled, true).pipe(
                      Effect.andThen(
                        stats.recordTimeout.pipe(Effect.catchCause(ignoreStats("timeout")))
                      ),
                      Effect.andThen(
                        Effect.fail(new CreateBatchTimeoutError({ timeoutMs: config.submitTimeoutMs }))
                      )
                    ),
                  onSome: (row) => Effect.succeed(row)
                })
              ),
              Effect.onInterrupt(() => Ref.set(queued.cancelled, true))
            )
          })
      })
    })
  ).pipe(Layer.provide(statsLayer))
}
