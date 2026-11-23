import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Cause, Clock, Context, Deferred, Effect, Equal, Exit, Fiber, Layer, Option, Queue, Ref, Result, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql"
import { isSqlError } from "effect/sql/SqlError"

import { Dialect } from "@/dialect/dialect.js"
import type { TransactionProbeStrategy } from "@/dialect/dialect.js"
import type { RepoRecord } from "@/repository/types.js"
import { annotateCurrentSpanWhenEnabled, withSpanWhenEnabled } from "@/telemetry/span.js"

import type { BatchOperation, CollectionError } from "./errors.js"
import {
  BatchMutationClosedError,
  BatchMutationConflictError,
  BatchMutationNestedTransactionError,
  BatchMutationQueueFullError,
  BatchMutationTimeoutError
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
 *   .batchMutation({ create: { windowMs: 2, maxBatchSize: 100 } })
 */
export interface MiraBatchOperationConfig {
  /** Master switch for this operation. Defaults to `true` when the operation is present. */
  readonly enabled?: boolean
  /** How long the flusher waits for more entries after the first one. Defaults to `0`. */
  readonly windowMs?: number
  /** Upper bound on records per flush (including the first entry). Defaults to `100`. */
  readonly maxBatchSize?: number
  /** Upper bound on queued entries. Defaults to `1_000`. */
  readonly maxQueueSize?: number
  /** Upper bound on queued payload bytes. Defaults to 32 MiB. */
  readonly maxQueueBytes?: number
  /** How long a request waits for its mutation before failing with a 503. Defaults to `10_000`. */
  readonly submitTimeoutMs?: number
}

export interface MiraBatchMutationConfig {
  /** Shared defaults applied to every operation, overridden per operation. */
  readonly windowMs?: number
  readonly maxBatchSize?: number
  readonly maxQueueSize?: number
  readonly maxQueueBytes?: number
  readonly submitTimeoutMs?: number
  /** Create batching. Present means enabled unless `enabled: false` is set. */
  readonly create?: MiraBatchOperationConfig
  /** Update batching. Present means enabled unless `enabled: false` is set. */
  readonly update?: MiraBatchOperationConfig
  /** Delete batching. Present means enabled unless `enabled: false` is set. */
  readonly delete?: MiraBatchOperationConfig
}

/** The only per-operation value retained after resolution. Shared bounds live on `queue`. */
export interface ResolvedBatchOperationConfig {
  readonly submitTimeoutMs: number
}

/** Effective bounds for the one shared FIFO queue. */
export interface ResolvedBatchQueueConfig {
  readonly windowMs: number
  readonly maxBatchSize: number
  readonly maxQueueSize: number
  readonly maxQueueBytes: number
  readonly submitTimeoutMs: number
}

export interface ResolvedBatchMutationConfig {
  readonly queue: ResolvedBatchQueueConfig | null
  readonly create: ResolvedBatchOperationConfig | null
  readonly update: ResolvedBatchOperationConfig | null
  readonly delete: ResolvedBatchOperationConfig | null
}

const DEFAULT_WINDOW_MS = 0
const DEFAULT_MAX_BATCH_SIZE = 100
const DEFAULT_MAX_QUEUE_SIZE = 1_000
const DEFAULT_MAX_QUEUE_BYTES = 32 * 1024 * 1024
const DEFAULT_SUBMIT_TIMEOUT_MS = 10_000

function resolveInteger(field: string, value: number | undefined, fallback: number, min: number) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`MiraBatchOperationConfig.${field} must be an integer >= ${min} (received ${String(value)})`)
  }
  return value
}

function resolveWindowMs(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `MiraBatchOperationConfig.windowMs must be a finite number >= 0 (received ${String(value)})`
    )
  }
  return value
}

interface OperationSettings {
  readonly windowMs: number
  readonly maxBatchSize: number
  readonly maxQueueSize: number
  readonly maxQueueBytes: number
  readonly submitTimeoutMs: number
}

function operationDefaults(config: MiraBatchMutationConfig): MiraBatchOperationConfig {
  return {
    ...(config.windowMs !== undefined ? { windowMs: config.windowMs } : {}),
    ...(config.maxBatchSize !== undefined ? { maxBatchSize: config.maxBatchSize } : {}),
    ...(config.maxQueueSize !== undefined ? { maxQueueSize: config.maxQueueSize } : {}),
    ...(config.maxQueueBytes !== undefined ? { maxQueueBytes: config.maxQueueBytes } : {}),
    ...(config.submitTimeoutMs !== undefined ? { submitTimeoutMs: config.submitTimeoutMs } : {})
  }
}

function resolveOperationSettings(
  operation: "create" | "update" | "delete",
  config: MiraBatchMutationConfig
): OperationSettings | null {
  const operationConfig = config[operation]
  if (operationConfig === undefined || operationConfig.enabled === false) return null
  const merged = { ...operationDefaults(config), ...operationConfig }
  return {
    windowMs: resolveWindowMs(merged.windowMs, DEFAULT_WINDOW_MS),
    maxBatchSize: resolveInteger("maxBatchSize", merged.maxBatchSize, DEFAULT_MAX_BATCH_SIZE, 1),
    maxQueueSize: resolveInteger("maxQueueSize", merged.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 1),
    maxQueueBytes: resolveInteger("maxQueueBytes", merged.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, 1),
    submitTimeoutMs: resolveInteger("submitTimeoutMs", merged.submitTimeoutMs, DEFAULT_SUBMIT_TIMEOUT_MS, 1)
  }
}

/**
 * Validate a single operation config and fill in defaults.
 *
 * Kept as a public helper for tests; the application resolver is
 * {@link resolveBatchMutationConfig}.
 */
export function resolveBatchOperationConfig(
  config?: MiraBatchOperationConfig
): ResolvedBatchOperationConfig | null {
  if (config?.enabled !== true) return null
  resolveWindowMs(config.windowMs, DEFAULT_WINDOW_MS)
  resolveInteger("maxBatchSize", config.maxBatchSize, DEFAULT_MAX_BATCH_SIZE, 1)
  resolveInteger("maxQueueSize", config.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 1)
  resolveInteger("maxQueueBytes", config.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES, 1)
  return {
    submitTimeoutMs: resolveInteger(
      "submitTimeoutMs",
      config.submitTimeoutMs,
      DEFAULT_SUBMIT_TIMEOUT_MS,
      1
    )
  }
}

export function resolveBatchMutationConfig(
  config?: MiraBatchMutationConfig
): ResolvedBatchMutationConfig {
  if (config === undefined) return { queue: null, create: null, update: null, delete: null }
  const createSettings = resolveOperationSettings("create", config)
  const updateSettings = resolveOperationSettings("update", config)
  const deleteSettings = resolveOperationSettings("delete", config)
  const enabled = [createSettings, updateSettings, deleteSettings].filter(
    (settings): settings is OperationSettings => settings !== null
  )
  if (enabled.length === 0) return { queue: null, create: null, update: null, delete: null }

  const first = enabled[0]
  if (first === undefined) return { queue: null, create: null, update: null, delete: null }
  for (const settings of enabled) {
    if (settings.submitTimeoutMs !== first.submitTimeoutMs) {
      const detail = enabled
        .map((entry, index) => `${["create", "update", "delete"][index] ?? "?"}=${entry.submitTimeoutMs}`)
        .join(", ")
      throw new Error(
        `MiraBatchMutationConfig.submitTimeoutMs must match across enabled operations (received ${detail})`
      )
    }
  }

  const queue: ResolvedBatchQueueConfig = {
    windowMs: Math.min(...enabled.map((settings) => settings.windowMs)),
    maxBatchSize: Math.min(...enabled.map((settings) => settings.maxBatchSize)),
    maxQueueSize: Math.min(...enabled.map((settings) => settings.maxQueueSize)),
    maxQueueBytes: Math.min(...enabled.map((settings) => settings.maxQueueBytes)),
    submitTimeoutMs: first.submitTimeoutMs
  }

  const publicConfig = (settings: OperationSettings | null): ResolvedBatchOperationConfig | null =>
    settings === null ? null : { submitTimeoutMs: settings.submitTimeoutMs }

  return {
    queue,
    create: publicConfig(createSettings),
    update: publicConfig(updateSettings),
    delete: publicConfig(deleteSettings)
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
 * One unit of batched work. `execute` closes over the collection-service
 * layer's repository/decoder/strip/rule helpers, so it requires no services and
 * can never re-resolve a different `SqlClient`.
 */
export interface MutationBatchResult {
  readonly value: RepoRecord
  readonly afterCommit: Effect.Effect<void>
}

export interface MutationBatchEntry {
  readonly operation: BatchOperation
  readonly collection: AnyCollectionDef
  readonly execute: Effect.Effect<MutationBatchResult, CollectionError>
  readonly estimatedBytes: number
}

interface QueuedEntry {
  readonly operation: BatchOperation
  readonly collection: AnyCollectionDef
  readonly execute: Effect.Effect<MutationBatchResult, CollectionError>
  readonly deferred: Deferred.Deferred<RepoRecord, CollectionError>
  /** One-way flag: only the owning request fiber writes; the flusher reads once. */
  readonly cancelled: { cancelled: boolean }
  readonly bytes: number
}

interface CleanupJob {
  readonly operation: BatchOperation
  readonly collection: string
  readonly effect: Effect.Effect<void>
}

type EntryOutcome =
  | { readonly _tag: "success"; readonly entry: QueuedEntry; readonly result: MutationBatchResult }
  | { readonly _tag: "failure"; readonly entry: QueuedEntry; readonly error: CollectionError }
  | { readonly _tag: "skipped"; readonly entry: QueuedEntry }

/**
 * The service that runs an already-prepared mutation. Always present:
 * `MutationBatcherDisabledLive` runs the execute effect inline, the real layer
 * queues it for the shared flusher. `submitInline` is the queue-bypassing path
 * used by a non-enabled operation and by internal auth flows.
 */
export class MutationBatcher extends Context.Service<
  MutationBatcher,
  {
    submit(entry: MutationBatchEntry): Effect.Effect<RepoRecord, CollectionError>
    submitInline(entry: MutationBatchEntry): Effect.Effect<RepoRecord, CollectionError>
  }
>()("mira/MutationBatcher") {}

export interface BatchOperationStatsSnapshot {
  readonly batches: number
  readonly applied: number
  readonly maxBatchSize: number
  readonly lastBatchSizes: ReadonlyArray<number>
  readonly rejected: number
  readonly timedOut: number
  readonly admitted: number
  readonly cleanupAbandoned: number
}

export interface BatchMutationStatsSnapshot {
  readonly commits: number
  readonly inlineCommits: number
  readonly batches: number
  readonly applied: number
  readonly maxBatchSize: number
  readonly lastBatchSizes: ReadonlyArray<number>
  readonly lastFlushDurationsMs: ReadonlyArray<number>
  readonly rejected: number
  readonly timedOut: number
  readonly admitted: number
  readonly consecutiveDefects: number
  readonly cleanupAbandoned: number
  readonly operations: {
    readonly create: BatchOperationStatsSnapshot
    readonly update: BatchOperationStatsSnapshot
    readonly delete: BatchOperationStatsSnapshot
  }
}

export interface BatchMutationFlush {
  readonly size: number
  readonly applied: number
  readonly durationMs: number
  readonly operations: ReadonlyArray<{
    readonly operation: BatchOperation
    readonly size: number
    readonly applied: number
  }>
}

/**
 * Observable counters plus the explicit flush trigger used by tests and the
 * benchmark. One instance per app build (layer memoization): the app provides
 * it to the batcher and exposes it to plugin routes.
 */
export class BatchMutationStats extends Context.Service<
  BatchMutationStats,
  {
    readonly flushSignal: Queue.Dequeue<void>
    readonly snapshot: Effect.Effect<BatchMutationStatsSnapshot>
    readonly reset: Effect.Effect<void>
    /** Called at the transaction chokepoint, after `COMMIT` returns. */
    readonly recordCommit: Effect.Effect<void>
    /** Called by the inline path; does not count as a flush commit. */
    readonly recordInlineCommit: (operation: BatchOperation) => Effect.Effect<void>
    readonly recordFlush: (flush: BatchMutationFlush) => Effect.Effect<void>
    readonly recordRejected: (operation: BatchOperation) => Effect.Effect<void>
    readonly recordDefect: Effect.Effect<void>
    readonly recordTimeout: (operation: BatchOperation) => Effect.Effect<void>
    readonly recordAdmitted: (operation: BatchOperation) => Effect.Effect<void>
    readonly recordCleanupAbandoned: (operation: BatchOperation) => Effect.Effect<void>
    /** Release a waiting flush immediately instead of waiting out `windowMs`. */
    readonly flushNow: Effect.Effect<void>
  }
>()("mira/BatchMutationStats") {}

interface OperationStatsState {
  readonly batches: number
  readonly applied: number
  readonly maxBatchSize: number
  readonly lastBatchSizes: ReadonlyArray<number>
  readonly rejected: number
  readonly timedOut: number
  readonly admitted: number
  readonly cleanupAbandoned: number
}

interface StatsState {
  readonly commits: number
  readonly inlineCommits: number
  readonly batches: number
  readonly applied: number
  readonly maxBatchSize: number
  readonly lastBatchSizes: ReadonlyArray<number>
  readonly lastFlushDurationsMs: ReadonlyArray<number>
  readonly rejected: number
  readonly timedOut: number
  readonly admitted: number
  readonly consecutiveDefects: number
  readonly cleanupAbandoned: number
  readonly create: OperationStatsState
  readonly update: OperationStatsState
  readonly delete: OperationStatsState
}

const initialOperationStats: OperationStatsState = {
  batches: 0,
  applied: 0,
  maxBatchSize: 0,
  lastBatchSizes: [],
  rejected: 0,
  timedOut: 0,
  admitted: 0,
  cleanupAbandoned: 0
}

const initialStatsState: StatsState = {
  commits: 0,
  inlineCommits: 0,
  batches: 0,
  applied: 0,
  maxBatchSize: 0,
  lastBatchSizes: [],
  lastFlushDurationsMs: [],
  rejected: 0,
  timedOut: 0,
  admitted: 0,
  consecutiveDefects: 0,
  cleanupAbandoned: 0,
  create: initialOperationStats,
  update: initialOperationStats,
  delete: initialOperationStats
}

const LAST_BATCH_SIZES = 50

function withOperationStats(
  state: StatsState,
  operation: BatchOperation,
  update: (current: OperationStatsState) => OperationStatsState
): StatsState {
  switch (operation) {
    case "create":
      return { ...state, create: update(state.create) }
    case "update":
      return { ...state, update: update(state.update) }
    case "delete":
      return { ...state, delete: update(state.delete) }
  }
}

/**
 * Create the single stats service value for an app build.
 *
 * The caller must merge this exact layer value into the service layer and pass
 * it to `makeMutationBatcherLayer`/`makeCachedCollectionServiceLayer` so layer
 * memoization yields one instance.
 */
export function makeBatchMutationStatsLayer(): Layer.Layer<BatchMutationStats> {
  return Layer.effect(
    BatchMutationStats,
    Effect.gen(function* () {
      const state = yield* Ref.make(initialStatsState)
      const flushSignal = yield* Queue.sliding<void>(1)

      const snapshotOf = (current: StatsState): BatchMutationStatsSnapshot => ({
        commits: current.commits,
        inlineCommits: current.inlineCommits,
        batches: current.batches,
        applied: current.applied,
        maxBatchSize: current.maxBatchSize,
        lastBatchSizes: current.lastBatchSizes,
        lastFlushDurationsMs: current.lastFlushDurationsMs,
        rejected: current.rejected,
        timedOut: current.timedOut,
        admitted: current.admitted,
        consecutiveDefects: current.consecutiveDefects,
        cleanupAbandoned: current.cleanupAbandoned,
        operations: {
          create: current.create,
          update: current.update,
          delete: current.delete
        }
      })

      return BatchMutationStats.of({
        flushSignal,
        snapshot: Effect.map(Ref.get(state), snapshotOf),
        reset: Ref.set(state, initialStatsState),
        recordCommit: Ref.update(state, (current) => ({ ...current, commits: current.commits + 1 })),
        recordInlineCommit: (operation) =>
          Ref.update(state, (current) => ({
            ...withOperationStats(current, operation, (op) => op),
            inlineCommits: current.inlineCommits + 1
          })),
        recordFlush: (flush) =>
          Ref.update(state, (current) => {
            let next: StatsState = {
              ...current,
              batches: current.batches + 1,
              applied: current.applied + flush.applied,
              maxBatchSize: Math.max(current.maxBatchSize, flush.size),
              lastBatchSizes: [...current.lastBatchSizes, flush.size].slice(-LAST_BATCH_SIZES),
              lastFlushDurationsMs: [
                ...current.lastFlushDurationsMs,
                flush.durationMs
              ].slice(-LAST_BATCH_SIZES),
              consecutiveDefects: 0
            }
            for (const entry of flush.operations) {
              next = withOperationStats(next, entry.operation, (op) => ({
                ...op,
                batches: op.batches + 1,
                applied: op.applied + entry.applied,
                maxBatchSize: Math.max(op.maxBatchSize, entry.size),
                lastBatchSizes: [...op.lastBatchSizes, entry.size].slice(-LAST_BATCH_SIZES)
              }))
            }
            return next
          }),
        recordRejected: (operation) =>
          Ref.update(state, (current) => ({
            ...withOperationStats(current, operation, (op) => ({ ...op, rejected: op.rejected + 1 })),
            rejected: current.rejected + 1
          })),
        recordDefect: Ref.update(state, (current) => ({
          ...current,
          consecutiveDefects: current.consecutiveDefects + 1
        })),
        recordTimeout: (operation) =>
          Ref.update(state, (current) => ({
            ...withOperationStats(current, operation, (op) => ({ ...op, timedOut: op.timedOut + 1 })),
            timedOut: current.timedOut + 1
          })),
        recordAdmitted: (operation) =>
          Ref.update(state, (current) => ({
            ...withOperationStats(current, operation, (op) => ({ ...op, admitted: op.admitted + 1 })),
            admitted: current.admitted + 1
          })),
        recordCleanupAbandoned: (operation) =>
          Ref.update(state, (current) => ({
            ...withOperationStats(current, operation, (op) => ({
              ...op,
              cleanupAbandoned: op.cleanupAbandoned + 1
            })),
            cleanupAbandoned: current.cleanupAbandoned + 1
          })),
        flushNow: Queue.offer(flushSignal, undefined).pipe(Effect.asVoid)
      })
    })
  )
}

/**
 * Batcher used when mutation batching is disabled: run the execute effect
 * inline, run its post-commit cleanup, record one inline commit, create no
 * queue and fork no fiber. This is the pre-batching behaviour.
 */
export const MutationBatcherDisabledLive: Layer.Layer<MutationBatcher> = Layer.effect(
  MutationBatcher,
  Effect.succeed(
    MutationBatcher.of({
      submit: (entry) => runInline(entry),
      submitInline: (entry) => runInline(entry)
    })
  )
)

const runInline = (entry: MutationBatchEntry): Effect.Effect<RepoRecord, CollectionError> =>
  Effect.gen(function* () {
    const result = yield* entry.execute
    yield* result.afterCommit.pipe(Effect.catchCause(() => Effect.void))
    yield* Effect.serviceOption(BatchMutationStats).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (stats) => stats.recordInlineCommit(entry.operation)
        })
      )
    )
    return result.value
  })

const MAX_COLLECTIONS_ATTRIBUTE = 256

function isConstraintCause(cause: Cause.Cause<unknown>): boolean {
  const defect = Cause.findDefect(cause)
  if (Result.isFailure(defect) || !isSqlError(defect.success)) return false
  const tag = defect.success.reason._tag
  return tag === "ConstraintError" || tag === "UniqueViolation"
}

function collectionErrorOf(
  cause: Cause.Cause<CollectionError | SqlError.SqlError>,
  pending: number,
  operation: BatchOperation
): CollectionError {
  const typed = Cause.findFail(cause)
  if (Result.isSuccess(typed)) return typed.success.error
  // A failed COMMIT arrives as a defect (`Effect.orDie`). A constraint defect
  // is a client-data conflict, not a batcher defect; it must map to 409 and
  // must not count toward the three-strike close.
  if (isConstraintCause(cause)) {
    return new BatchMutationConflictError({ operation })
  }
  return new BatchMutationClosedError({ pending, operation })
}

/**
 * The verdict of a transaction-liveness probe, plus the `SqlError` reason tag
 * of the probe statement that failed when the probe reported not-usable.
 */
export interface TransactionProbeResult {
  readonly alive: boolean
  readonly probeFailureTag?: string
}

/** Extracts the `SqlError` reason tag from a probe statement's failure cause. */
const probeFailureTagOf = (cause: Cause.Cause<SqlError.SqlError>): string | undefined => {
  const fail = Cause.findFail(cause)
  if (Result.isFailure(fail)) return undefined
  if (!isSqlError(fail.success.error)) return undefined
  return fail.success.error.reason._tag
}

/**
 * Probe whether the current SQL transaction is still usable.
 *
 * The caller must already be inside a transaction: the batch body runs inside
 * the flusher's outer `sql.withTransaction`, and the probe executes on that
 * same transaction connection.
 *
 * `SELECT 1` runs first. On a dead connection, or inside an aborted
 * transaction, every statement fails, so the probe reports not-usable and
 * carries the `SqlError` reason tag of the failed `SELECT 1` as
 * `probeFailureTag`. The strategy then decides how to classify the remaining
 * states, and the strategies fail differently:
 *
 * - `select-only`: `SELECT 1` is the whole probe. A successful `SELECT 1`
 *   means the transaction is usable; a failed one means it is not. The
 *   strategy fails closed: any `SELECT 1` failure, not only connection
 *   death, reports not-usable. No transaction control statement is issued,
 *   so the probe cannot damage the outer transaction.
 * - `nested-begin`: `BEGIN` is the second probe. `BEGIN` fails while the
 *   outer transaction is alive (the alive signal, not a death), and succeeds
 *   (starting a throwaway transaction) once the engine has implicitly rolled
 *   the outer transaction back. A successful `BEGIN` is undone with a
 *   throwaway `ROLLBACK`, and the probe then reports not-usable.
 *
 * Exported for the focused probe tests.
 *
 * @internal
 */
export const probeTransactionAlive = (
  sql: SqlClient.SqlClient,
  strategy: TransactionProbeStrategy
): Effect.Effect<TransactionProbeResult> =>
  Effect.gen(function* () {
    const select = yield* Effect.exit(sql`SELECT 1 AS ok`)
    if (Exit.isFailure(select)) {
      const probeFailureTag = probeFailureTagOf(select.cause)
      return {
        alive: false,
        ...(probeFailureTag !== undefined ? { probeFailureTag } : {})
      }
    }
    if (strategy === "select-only") return { alive: true }
    const begin = yield* Effect.exit(sql`${sql.literal("BEGIN")}`)
    if (Exit.isFailure(begin)) return { alive: true }
    yield* Effect.exit(sql`${sql.literal("ROLLBACK")}`)
    return { alive: false }
  })

/** The probe outcome for one flush, recorded for the batch span annotation. */
interface ProbeObservation {
  readonly strategy: TransactionProbeStrategy
  readonly result: TransactionProbeResult
}

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
 * @param statsLayer - The app's single `BatchMutationStats` layer value
 */
export function makeMutationBatcherLayer(
  config: ResolvedBatchMutationConfig,
  statsLayer: Layer.Layer<BatchMutationStats>
): Layer.Layer<MutationBatcher, never, SqlClient.SqlClient | Dialect> {
  // The disabled-batch early return technically claims the `Dialect` requirement it does not use.
  if (config.queue === null) return MutationBatcherDisabledLive
  const queueConfig = config.queue
  return Layer.effect(
    MutationBatcher,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const dialect = yield* Dialect
      const transactionProbe = dialect.transactionProbe
      const stats = yield* BatchMutationStats

      const queue = yield* Queue.unbounded<QueuedEntry>()
      const cleanupQueue = yield* Queue.bounded<CleanupJob>(1_024)
      const cleanupWorker = Effect.forever(
        Effect.gen(function* () {
          const job = yield* Queue.take(cleanupQueue)
          yield* job.effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("mutation-batch.cleanup_failed", {
                collection: job.collection,
                operation: job.operation,
                cause: Cause.pretty(cause)
              })
            )
          )
        }).pipe(Effect.catchCause(() => Effect.void))
      )
      yield* Effect.forEach(
        [0, 1, 2, 3],
        () => Effect.forkScoped(cleanupWorker),
        { concurrency: 4 }
      )
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
        Effect.logWarning("mutation-batch.stats_failed", { stage, cause: Cause.pretty(cause) })

      const failEntries = (
        entries: ReadonlyArray<QueuedEntry>,
        makeError: (entry: QueuedEntry) => CollectionError
      ) =>
        Effect.forEach(
          entries,
          (entry) => Deferred.fail(entry.deferred, makeError(entry)),
          { concurrency: 1 }
        )

      const drainQueue: Effect.Effect<ReadonlyArray<QueuedEntry>> = Effect.gen(function* () {
        const size = yield* Queue.size(queue)
        if (size === 0) return []
        const drained = yield* Queue.takeN(queue, size)
        yield* release(drained)
        return drained
      })

      /** Fail everything still queued, releasing its budget. */
      const failQueue = (
        makeError: (pending: number, entry: QueuedEntry) => CollectionError
      ) =>
        Effect.gen(function* () {
          const drained = yield* drainQueue
          yield* failEntries(drained, (entry) => makeError(drained.length, entry))
          return drained.length
        })

      /**
       * Fail every not-yet-settled deferred of a batch. `Deferred.fail` is a
       * no-op for entries already completed, so this is safe to run after the
       * per-entry settlement and on interruption.
       */
      const failRemaining = (
        entries: ReadonlyArray<QueuedEntry>,
        makeError: (entry: QueuedEntry) => CollectionError
      ) =>
        Effect.forEach(
          entries,
          (entry) => Deferred.fail(entry.deferred, makeError(entry)),
          { concurrency: 1 }
        )

      const settle = (
        entries: ReadonlyArray<QueuedEntry>,
        outcomes: Ref.Ref<ReadonlyArray<EntryOutcome>>,
        exit: Exit.Exit<void, CollectionError | SqlError.SqlError>,
        aborted: Ref.Ref<Option.Option<Cause.Cause<CollectionError>>>,
        startedAt: number
      ) =>
        Effect.gen(function* () {
          const durationMs = (yield* Clock.currentTimeMillis) - startedAt
          if (Exit.isSuccess(exit)) {
            const settled = yield* Ref.get(outcomes)
            // Deferreds FIRST: the rows are committed, so each request's HTTP
            // outcome must not depend on a counter or on cleanup. Stats and
            // post-commit cleanup run afterwards.
            for (const outcome of settled) {
              if (outcome._tag === "success") {
                yield* Deferred.succeed(outcome.entry.deferred, outcome.result.value)
              } else if (outcome._tag === "failure") {
                yield* Deferred.fail(outcome.entry.deferred, outcome.error)
              } else {
                yield* Deferred.interrupt(outcome.entry.deferred)
              }
            }

            for (const outcome of settled) {
              if (outcome._tag !== "success") continue
              const offered = yield* Effect.sync(() =>
                Queue.offerUnsafe(cleanupQueue, {
                  operation: outcome.entry.operation,
                  collection: outcome.entry.collection.name,
                  effect: outcome.result.afterCommit
                })
              )
              if (!offered) {
                yield* stats
                  .recordCleanupAbandoned(outcome.entry.operation)
                  .pipe(Effect.catchCause(ignoreStats("cleanup_abandoned")))
                yield* Effect.logWarning("mutation-batch.cleanup_abandoned", {
                  operation: outcome.entry.operation,
                  collection: outcome.entry.collection.name
                })
              }
            }

            const written = settled.filter((outcome) => outcome._tag === "success").length
            const counts = new Map<BatchOperation, { size: number; applied: number }>()
            for (const entry of entries) {
              const current = counts.get(entry.operation) ?? { size: 0, applied: 0 }
              counts.set(entry.operation, { ...current, size: current.size + 1 })
            }
            for (const outcome of settled) {
              if (outcome._tag !== "success") continue
              const current = counts.get(outcome.entry.operation) ?? { size: 0, applied: 0 }
              counts.set(outcome.entry.operation, { ...current, applied: current.applied + 1 })
            }
            yield* stats.recordCommit.pipe(Effect.catchCause(ignoreStats("commit")))
            yield* stats
              .recordFlush({
                size: entries.length,
                applied: written,
                durationMs,
                operations: [...counts.entries()].map(([operation, value]) => ({
                  operation,
                  ...value
                }))
              })
              .pipe(Effect.catchCause(ignoreStats("flush")))
            return
          }

          const pending = entries.length
          const isClosed = yield* Ref.get(closed)
          const abortCause = yield* Ref.get(aborted)
          const makeError = (entry: QueuedEntry): CollectionError => {
            if (Option.isSome(abortCause)) {
              return collectionErrorOf(abortCause.value, pending, entry.operation)
            }
            if (Cause.hasInterruptsOnly(exit.cause) || isClosed) {
              return new BatchMutationClosedError({ pending, operation: entry.operation })
            }
            return collectionErrorOf(exit.cause, pending, entry.operation)
          }
          yield* failRemaining(entries, makeError)
        }).pipe(Effect.uninterruptible)

      const runBatchBody = (
        taken: ReadonlyArray<QueuedEntry>,
        outcomes: Ref.Ref<ReadonlyArray<EntryOutcome>>,
        aborted: Ref.Ref<Option.Option<Cause.Cause<CollectionError>>>,
        probeRecord: Ref.Ref<Option.Option<ProbeObservation>>
      ) =>
        Effect.gen(function* () {
          const settled: Array<EntryOutcome> = []
          for (const [index, entry] of taken.entries()) {
            if (entry.cancelled.cancelled) {
              settled.push({ _tag: "skipped", entry })
              continue
            }

            // Capture this entry's own failure cause *before* the driver's
            // savepoint finalizer runs: when a transaction-fatal error has
            // already rolled the savepoint back, `ROLLBACK TO SAVEPOINT` dies
            // and would otherwise replace the real error with a defect.
            const observed: { cause: Option.Option<Cause.Cause<CollectionError>> } = {
              cause: Option.none()
            }
            const execute = entry.execute.pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.sync(() => {
                      observed.cause = Option.some(exit.cause)
                    })
                  : Effect.void
              ),
              withSpanWhenEnabled(
                "collection.mutateInBatch",
                {
                  kind: "internal",
                  attributes: {
                    "batch.index": index,
                    collection: entry.collection.name,
                    operation: entry.operation
                  }
                },
                { captureStackTrace: false }
              )
            )

            // One entry never needs a savepoint: the outer transaction rolls
            // it back anyway, and this is the low-concurrency path.
            const guarded = taken.length === 1 ? execute : sql.withTransaction(execute)
            const result = yield* Effect.exit(guarded)

            if (Exit.isSuccess(result)) {
              settled.push({ _tag: "success", entry, result: result.value })
              continue
            }

            if (Cause.hasInterruptsOnly(result.cause)) {
              yield* Ref.set(outcomes, settled)
              return yield* Effect.failCause(result.cause)
            }

            const originalCause = Option.getOrElse(observed.cause, () => result.cause)

            // The savepoint wrapper (`@effect/sql` renders the driver's nested
            // transaction as savepoint statements wrapped in `Effect.orDie`)
            // replaces a failed rollback or release with a defect. If the
            // guarded exit does not carry the entry's own cause, the wrapper
            // injected a failure: abort the batch as transaction-fatal with
            // the captured cause without probing, so a failed entry can never
            // commit its partial writes.
            if (Option.isNone(observed.cause) || !Equal.equals(result.cause, observed.cause.value)) {
              yield* Ref.set(aborted, Option.some(originalCause))
              yield* Ref.set(outcomes, settled)
              return yield* Effect.failCause(result.cause)
            }

            const probe = yield* probeTransactionAlive(sql, transactionProbe)
            yield* Ref.set(probeRecord, Option.some({ strategy: transactionProbe, result: probe }))
            if (!probe.alive) {
              // Transaction-fatal: every entry in the batch fails with the
              // entry's own cause, and the commit is skipped.
              yield* Ref.set(aborted, Option.some(originalCause))
              yield* Ref.set(outcomes, settled)
              return yield* Effect.failCause(result.cause)
            }

            // Statement-level: only this savepoint rolled back; the rest of the
            // batch still commits.
            settled.push({
              _tag: "failure",
              entry,
              error: collectionErrorOf(originalCause, taken.length, entry.operation)
            })
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

        const remaining = queueConfig.maxBatchSize - 1
        // Drain what is already queued; only wait when the batch is still
        // below the cap.
        if ((yield* Queue.size(queue)) < remaining) {
          yield* waitForWindow(queueConfig.windowMs, stats.flushSignal)
        }

        const size = yield* Queue.size(queue)
        if (size > 0) {
          const more = yield* Queue.takeN(queue, Math.min(size, queueConfig.maxBatchSize - taken.length))
          taken.push(...more)
        }
        yield* Ref.set(inFlight, taken)
        yield* release(taken)

        const outcomes = yield* Ref.make<ReadonlyArray<EntryOutcome>>([])
        const aborted = yield* Ref.make<Option.Option<Cause.Cause<CollectionError>>>(Option.none())
        const probeRecord = yield* Ref.make<Option.Option<ProbeObservation>>(Option.none())
        const collections = [...new Set(taken.map((entry) => entry.collection.name))]
        const operationCounts = new Map<BatchOperation, number>()
        for (const entry of taken) {
          operationCounts.set(entry.operation, (operationCounts.get(entry.operation) ?? 0) + 1)
        }
        const startedAt = yield* Clock.currentTimeMillis

        yield* sql.withTransaction(runBatchBody(taken, outcomes, aborted, probeRecord)).pipe(
          // Annotated here, between the driver's transaction and the batch
          // span wrapper, so the probe outcome lands on the current
          // `collection.mutationBatch` span: inside the body the current span
          // would be the driver's nested `sql.transaction` span, which closes
          // first. Runs on success and failure; a batch that failed before
          // probing records nothing.
          Effect.onExit(() =>
            Effect.gen(function* () {
              const probe = yield* Ref.get(probeRecord)
              if (Option.isNone(probe)) return
              yield* annotateCurrentSpanWhenEnabled((span) => {
                span.attribute("batch.probeStrategy", probe.value.strategy)
                span.attribute(
                  "batch.probeVerdict",
                  probe.value.result.alive ? "alive" : "not-usable"
                )
                if (probe.value.result.probeFailureTag !== undefined) {
                  span.attribute("batch.probeFailureTag", probe.value.result.probeFailureTag)
                }
              })
            })
          ),
          withSpanWhenEnabled(
            "collection.mutationBatch",
            {
              kind: "internal",
              attributes: {
                "batch.size": taken.length,
                "batch.operationCount": operationCounts.size,
                "batch.operations": [...operationCounts.keys()].join(","),
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
          Effect.onExit((exit) => settle(taken, outcomes, exit, aborted, startedAt))
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
                  yield* failRemaining(entries, (entry) =>
                    isClosed
                      ? new BatchMutationClosedError({
                          pending: entries.length,
                          operation: entry.operation
                        })
                      : collectionErrorOf(exit.cause, entries.length, entry.operation)
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
          const pending = yield* failQueue(
            (count, entry) =>
              new BatchMutationClosedError({ pending: count, operation: entry.operation })
          )
          yield* Effect.logError("mutation-batch.degraded", {
            consecutiveDefects: defects,
            pending
          })
        }).pipe(Effect.ensuring(Queue.shutdown(queue).pipe(Effect.catchCause(() => Effect.void))))

      const degraded = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          yield* Effect.logError("mutation-batch.flush_defect", { cause: Cause.pretty(cause) })
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
              yield* Effect.logError("mutation-batch.degraded_failed", {
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
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            // A constraint abort at COMMIT was already settled as a 409 by
            // `settle`; it is not a batcher defect and must not count toward
            // the three-strike close.
            if (isConstraintCause(cause)) return Effect.void
            return degraded(cause)
          })
        )
      )

      const flusher = yield* Effect.forkScoped(loop)

      yield* Effect.addFinalizer(() =>
        Effect.uninterruptible(
          lifecycle.withPermit(
            Effect.gen(function* () {
              // 1. New submissions fail fast, and the flusher's exit handler
              //    knows to report `BatchMutationClosedError`.
              yield* close
              // 2. Interrupt the flusher and wait for it. Its transaction body
              //    is interruptible, so an in-flight transaction rolls back;
              //    the post-commit segment is uninterruptible and still
              //    succeeds.
              yield* Fiber.interrupt(flusher)
              // 3. Fail whatever is still waiting (queue + in-flight).
              const pending = yield* failQueue(
                (count, entry) =>
                  new BatchMutationClosedError({ pending: count, operation: entry.operation })
              )
              const remaining = yield* Ref.get(inFlight)
              yield* failRemaining(
                remaining,
                (entry) =>
                  new BatchMutationClosedError({
                    pending: pending + remaining.length,
                    operation: entry.operation
                  })
              )
              yield* Ref.set(inFlight, [])
              // 4. Stop blocked internal operations, then let the scope release
              //    downstream services.
              yield* Queue.shutdown(queue)
              yield* Queue.shutdown(cleanupQueue)
            })
          )
        )
      )

      const submitQueued = (entry: MutationBatchEntry) =>
        Effect.gen(function* () {
          // Calling contract: an enabled operation must not run in a fiber that
          // already holds the SQL transaction connection. The flusher could
          // never acquire it, so fail fast instead of deadlocking.
          const context = yield* Effect.context()
          if (Option.isSome(Context.getOption(context, sql.transactionService))) {
            return yield* Effect.fail(
              new BatchMutationNestedTransactionError({ operation: entry.operation })
            )
          }

          // A single entry larger than the whole byte budget can never be
          // admitted: fail fast instead of clamping it into the queue.
          if (entry.estimatedBytes > queueConfig.maxQueueBytes) {
            yield* stats
              .recordRejected(entry.operation)
              .pipe(Effect.catchCause(ignoreStats("rejected")))
            return yield* Effect.fail(
              new BatchMutationQueueFullError({
                limit: queueConfig.maxQueueBytes,
                operation: entry.operation
              })
            )
          }

          const bytes = Math.max(0, entry.estimatedBytes)
          const deferred = yield* Deferred.make<RepoRecord, CollectionError>()
          const cancelled = { cancelled: false }
          const queued: QueuedEntry = {
            operation: entry.operation,
            collection: entry.collection,
            execute: entry.execute,
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
                if (current.count >= queueConfig.maxQueueSize) {
                  return ["count" as const, current] as const
                }
                if (current.bytes + bytes > queueConfig.maxQueueBytes) {
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
              yield* stats
                .recordAdmitted(entry.operation)
                .pipe(Effect.catchCause(ignoreStats("admitted")))
              return "admitted" as const
            })
          )

          if (admission === "closed") {
            return yield* Effect.fail(
              new BatchMutationClosedError({
                pending: yield* pendingCount,
                operation: entry.operation
              })
            )
          }
          if (admission !== "admitted") {
            yield* stats
              .recordRejected(entry.operation)
              .pipe(Effect.catchCause(ignoreStats("rejected")))
            return yield* Effect.fail(
              new BatchMutationQueueFullError({
                limit:
                  admission === "bytes" ? queueConfig.maxQueueBytes : queueConfig.maxQueueSize,
                operation: entry.operation
              })
            )
          }

          return yield* Deferred.await(queued.deferred).pipe(
            Effect.timeoutOption(queueConfig.submitTimeoutMs),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.sync(() => {
                    queued.cancelled.cancelled = true
                  }).pipe(
                    Effect.andThen(
                      stats
                        .recordTimeout(entry.operation)
                        .pipe(Effect.catchCause(ignoreStats("timeout")))
                    ),
                    Effect.andThen(
                      Effect.fail(
                        new BatchMutationTimeoutError({
                          timeoutMs: queueConfig.submitTimeoutMs,
                          operation: entry.operation
                        })
                      )
                    )
                  ),
                onSome: (row) => Effect.succeed(row)
              })
            ),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                queued.cancelled.cancelled = true
              })
            )
          )
        })

      return MutationBatcher.of({
        submit: (entry) =>
          config[entry.operation] === null ? runInline(entry) : submitQueued(entry),
        submitInline: (entry) => runInline(entry)
      })
    })
  ).pipe(Layer.provide(statsLayer))
}
