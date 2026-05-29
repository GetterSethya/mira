import { HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"
import type { CollectionError } from "@/collection-service/errors.js"
import type { FileStorageError } from "@/storage/storage.js"

/**
 * Effect error handler that maps `CollectionError` and `FileStorageError` variants
 * to HTTP response objects with appropriate status codes.
 *
 * | Error | HTTP Status |
 * |---|---|
 * | `NotFoundError` | 404 |
 * | `ForbiddenError` | 403 |
 * | `ValidationError` | 422 |
 * | `ReadOnlyError` | 405 |
 * | `FileStorageError` | 502 |
 * | `SqlError` | 500 |
 *
 * Use this as a final `.pipe()` call in route handlers to convert domain errors
 * to HTTP responses.
 *
 * @example
 * import { catchCollectionErrors } from "@gettersethya/mira"
 *
 * const handler = Effect.gen(function* () { ... }).pipe(
 *   catchCollectionErrors
 * )
 *
 * @see CollectionError — the union type this handler catches
 */
export const catchCollectionErrors = <A, R>(
  eff: Effect.Effect<A, CollectionError | FileStorageError, R>
): Effect.Effect<A, HttpServerResponse.HttpServerResponse, R> =>
  Effect.catchTags(eff, {
    NotFoundError: (e) =>
      Effect.fail(
        HttpServerResponse.unsafeJson(
          { error: "not_found", message: `Record not found in "${e.collection}"` },
          { status: 404 as const }
        )
      ),
    ForbiddenError: () =>
      Effect.fail(
        HttpServerResponse.unsafeJson({ error: "forbidden" }, { status: 403 as const })
      ),
    ValidationError: (e) =>
      Effect.fail(
        HttpServerResponse.unsafeJson(
          { error: "validation_failed", issues: e.issues },
          { status: 422 as const }
        )
      ),
    ReadOnlyError: () =>
      Effect.fail(
        HttpServerResponse.unsafeJson({ error: "read_only" }, { status: 405 as const })
      ),
    FileStorageError: (e) =>
      Effect.fail(
        HttpServerResponse.unsafeJson(
          { error: "storage_error", reason: e.reason },
          { status: 502 as const }
        )
      ),
    SqlError: () =>
      Effect.fail(
        HttpServerResponse.unsafeJson({ error: "internal_error" }, { status: 500 as const })
      ),
  })
