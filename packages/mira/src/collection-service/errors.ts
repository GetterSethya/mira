import { Data } from "effect"
import type { SqlError } from "@effect/sql"
import { ValidationError } from "@gettersethya/mira-client"

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
 * Union of all errors that can be raised by CollectionService operations.
 * Includes NotFoundError, ForbiddenError, ValidationError, ReadOnlyError, and SqlError.
 *
 * @see CollectionService — all methods fail with CollectionError
 */
export type CollectionError =
  | NotFoundError
  | ForbiddenError
  | ValidationError
  | ReadOnlyError
  | SqlError.SqlError
