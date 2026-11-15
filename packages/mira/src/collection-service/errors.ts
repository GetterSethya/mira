import { ValidationError } from "@gettersethya/mira-client"
import { Data } from "effect"
import type { SqlError } from "effect/sql"

export { ValidationError }

/**
 * Error raised when a requested record is not found.
 * Contains the collection name and the requested record ID.
 *
 * The server returns HTTP 404 when this error propagates to the HTTP layer.
 *
 * @example
 * new NotFoundError({ collection: "posts", id: "abc123" })
 *
 * @see CollectionService — raises this error on getOne/update/delete for missing records
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  collection: string
  id: string
}> {}

/**
 * Error raised when an action is forbidden by access rules.
 * Contains the collection name and the attempted action.
 *
 * The server returns HTTP 403 when this error propagates to the HTTP layer.
 *
 * @example
 * new ForbiddenError({ collection: "posts", action: "update" })
 *
 * @see CollectionService — raises this error when rules deny an action
 */
export class ForbiddenError extends Data.TaggedError("ForbiddenError")<{
  collection: string
  action: string
}> {}

/**
 * Error raised when a write operation is attempted on a read-only collection.
 * View collections always raise this on create/update/delete.
 *
 * The server returns HTTP 405 (Method Not Allowed) when this error propagates.
 *
 * @example
 * new ReadOnlyError({ collection: "active_posts" })
 *
 * @see ViewCollection — view collections are read-only
 */
export class ReadOnlyError extends Data.TaggedError("ReadOnlyError")<{
  collection: string
}> {}

/**
 * Error raised when a request payload exceeds a server-imposed size limit
 * (a request-level body budget, or a per-file / per-field cap).
 *
 * The server returns HTTP 413 when this error propagates to the HTTP layer.
 *
 * @example
 * new PayloadTooLargeError({ limit: 2_097_152, detail: "File exceeds 2097152 bytes" })
 */
export class PayloadTooLargeError extends Data.TaggedError("PayloadTooLargeError")<{
  limit: number
  detail: string
}> {}

/**
 * Error raised when the create batcher is shutting down (or has been marked
 * degraded after repeated flush defects) and can no longer accept new inserts.
 *
 * The server returns HTTP 503 `{ error: "batch_unavailable", retryable: false }`
 * when this error propagates. Deliberately no `Retry-After`: a create is not
 * idempotent, so an automatic retry can duplicate a row.
 *
 * @example
 * new CreateBatchClosedError({ pending: 3 })
 *
 * @see CreateBatcher — the queue that raises this on shutdown
 */
export class CreateBatchClosedError extends Data.TaggedError("CreateBatchClosedError")<{
  readonly pending: number
}> {}

/**
 * Error raised when the create batch queue is already at its entry-count or
 * byte budget. Admission is fail-fast — it never suspends the request.
 *
 * The server returns HTTP 503 `{ error: "batch_unavailable", retryable: false }`.
 *
 * @example
 * new CreateBatchQueueFullError({ limit: 1_000 })
 */
export class CreateBatchQueueFullError extends Data.TaggedError("CreateBatchQueueFullError")<{
  readonly limit: number
}> {}

/**
 * Error raised when a queued create is not resolved by the flusher before
 * `submitTimeoutMs`. Guards against a wedged flusher becoming an indefinite
 * request hang.
 *
 * The server returns HTTP 503 `{ error: "batch_unavailable", retryable: false }`.
 * If the insert commits after the timeout, the client never receives the
 * response — do not blindly retry creates.
 *
 * @example
 * new CreateBatchTimeoutError({ timeoutMs: 10_000 })
 */
export class CreateBatchTimeoutError extends Data.TaggedError("CreateBatchTimeoutError")<{
  readonly timeoutMs: number
}> {}

/**
 * Error raised when `create` is called from a fiber that already holds the
 * `SqlClient` transaction connection. With batching enabled the insert runs in
 * the flusher fiber, which cannot acquire the connection the caller holds, so
 * the request would deadlock. This is a programmer error.
 *
 * The server returns HTTP 500 `{ error: "create_inside_transaction" }`.
 *
 * @example
 * Effect.gen(function* () {
 *   yield* sql.withTransaction(svc.create(Posts, data, ctx))
 * })
 */
export class CreateBatchNestedTransactionError extends Data.TaggedError("CreateBatchNestedTransactionError")<{}> {}

/**
 * Union of all errors that can be raised by CollectionService operations.
 * Includes NotFoundError, ForbiddenError, ValidationError, ReadOnlyError,
 * PayloadTooLargeError, the create-batch errors, and SqlError.
 *
 * `createMany` never raises the create-batch errors; the shared union is widened
 * for type simplicity.
 *
 * @see CollectionService — all methods fail with CollectionError
 */
export type CollectionError =
  | NotFoundError
  | ForbiddenError
  | ValidationError
  | ReadOnlyError
  | PayloadTooLargeError
  | CreateBatchClosedError
  | CreateBatchQueueFullError
  | CreateBatchTimeoutError
  | CreateBatchNestedTransactionError
  | SqlError.SqlError
