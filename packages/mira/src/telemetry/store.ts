import type { FilterNode } from "@gettersethya/mira-client"
import type { ValidationError } from "@gettersethya/mira-client"
import { Context, Data, type Effect } from "effect"

/** A log row ready for persistence. The core owns id and timestamp generation. */
export interface TelemetryLogEntry {
  readonly id: string
  readonly level: string
  readonly message: string
  readonly created: string
  readonly updated: string
  // Null, not optional: every row in a batch must carry the same columns.
  readonly traceId: string | null
  readonly spanId: string | null
}

/** A completed span ready for persistence. */
export interface TelemetrySpanEntry {
  readonly id: string
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly kind: string
  readonly durationMs: number
  readonly status: "ok" | "error"
  readonly error: string | null
  readonly attributes: Readonly<Record<string, string | number | boolean>>
  readonly created: string
  readonly updated: string
}

export interface TelemetryListQuery {
  readonly limit: number
  readonly after: number | null
  readonly filter: FilterNode | null
  readonly traceId: string | null
}

export interface TelemetryLogRow {
  readonly seqId: number
  readonly id: string
  readonly level: string
  readonly message: string
  readonly created: string
  readonly updated: string
  readonly traceId: string | null
  readonly spanId: string | null
}

/**
 * Public span row. It intentionally has no `seqId`, matching the current
 * route JSON. The SQL store selects `seqId` in a private raw row and uses it
 * only to compute `nextCursor`.
 */
export interface TelemetrySpanRow {
  readonly id: string
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly kind: string
  readonly durationMs: number
  readonly status: "ok" | "error"
  readonly error: string | null
  readonly attributes: Readonly<Record<string, string | number | boolean>>
  readonly created: string
}

export interface TelemetryLogPage {
  readonly items: ReadonlyArray<TelemetryLogRow>
  readonly total: number
  readonly nextCursor: number | null
}

export interface TelemetrySpanPage {
  readonly items: ReadonlyArray<TelemetrySpanRow>
  readonly total: number
  readonly nextCursor: number | null
}

export interface TelemetryDeleteResult {
  readonly logs: number
  readonly spans: number
}

export interface TelemetryReadShape {
  readonly listLogs: (
    query: TelemetryListQuery
  ) => Effect.Effect<TelemetryLogPage, TelemetryStoreError | ValidationError>
  readonly listSpans: (
    query: TelemetryListQuery
  ) => Effect.Effect<TelemetrySpanPage, TelemetryStoreError | ValidationError>
}

export interface TelemetryStoreShape {
  readonly appendLogs: (
    rows: ReadonlyArray<TelemetryLogEntry>
  ) => Effect.Effect<void, TelemetryStoreError | TelemetryDuplicateEntryError>
  readonly appendSpans: (
    rows: ReadonlyArray<TelemetrySpanEntry>
  ) => Effect.Effect<void, TelemetryStoreError | TelemetryDuplicateEntryError>
  readonly deleteOlderThan: (
    cutoff: string
  ) => Effect.Effect<TelemetryDeleteResult, TelemetryStoreError>
  readonly read: TelemetryReadShape | null
}

/** A persistence failure in the telemetry store. */
export class TelemetryStoreError extends Data.TaggedError("TelemetryStoreError")<{
  readonly operation: string
  readonly cause?: unknown
}> {}

/**
 * An append failed because at least one row id already exists.
 *
 * The SQL store does not produce this error: it inserts with a dialect
 * conflict clause, so a duplicate id is a no-op. A non-SQL store that cannot
 * ignore duplicates returns this error, and the SQL-free core treats a single
 * duplicate row as success.
 */
export class TelemetryDuplicateEntryError extends Data.TaggedError(
  "TelemetryDuplicateEntryError"
)<{
  readonly operation: string
  readonly ids?: ReadonlyArray<string>
}> {}

/**
 * The only persistence interface the telemetry core knows.
 *
 * `appendLogs` and `appendSpans` are idempotent by entry `id`: a retry of a row
 * that already committed must be a no-op. A store that cannot enforce this must
 * return `TelemetryDuplicateEntryError` rather than appending the row twice.
 *
 * The SQL store enforces idempotency with a conflict-ignoring insert. A direct
 * append in shared mode joins the caller transaction; the core's forked
 * consumers run outside it.
 */
export class TelemetryStore extends Context.Service<
  TelemetryStore,
  TelemetryStoreShape
>()("TelemetryStore") {}
