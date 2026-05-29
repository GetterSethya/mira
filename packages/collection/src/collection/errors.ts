import { Data } from "effect"

/**
 * Error raised when collection field validation fails.
 * Contains the collection name and a list of human-readable issue descriptions.
 *
 * Raised by:
 * - `filterNodeToWhereClause()` — when a filter references an unknown field
 * - `CollectionService` — when field-level constraints (type, required, min/max length, etc.)
 *   fail validation on create or update
 * - Effect Schema validation — when input fails schema decoding
 *
 * @example
 * new ValidationError({
 *   collection: "posts",
 *   issues: ['Field "title" is required']
 * })
 *
 * @see CollectionService — service that raises ValidationError
 * @see filterNodeToWhereClause — raises ValidationError for unknown filter fields
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  collection: string
  issues: ReadonlyArray<string>
}> {}
