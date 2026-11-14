import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import type { SqlError } from "effect/sql"

import type { AuthEmailError } from "@/auth/errors.js"
import type { CollectionError } from "@/collection-service/errors.js"
import type { AuthError } from "./auth.js"
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
 * | `PayloadTooLargeError` | 413 |
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
        HttpServerResponse.jsonUnsafe(
          { error: "not_found", message: `Record not found in "${e.collection}"` },
          { status: 404 as const }
        )
      ),
    ForbiddenError: () =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 as const })
      ),
    ValidationError: (e) =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe(
          { error: "validation_failed", issues: e.issues },
          { status: 422 as const }
        )
      ),
    ReadOnlyError: () =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe({ error: "read_only" }, { status: 405 as const })
      ),
    PayloadTooLargeError: (e) =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe(
          { error: "payload_too_large", detail: e.detail, limit: e.limit },
          { status: 413 as const }
        )
      ),
    FileStorageError: (e) =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe(
          { error: "storage_error", reason: e.reason },
          { status: 502 as const }
        )
      ),
    SqlError: () =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe({ error: "internal_error" }, { status: 500 as const })
      ),
  })

/**
 * Maps auth-email failures to the public status table. `EmailNotConfiguredError`
 * and `EmailSendError` are mapped as well so a route cannot accidentally expose a
 * generic 500.
 */
export const catchAuthEmailErrors = <A, R>(
  eff: Effect.Effect<A, AuthEmailError | AuthError | SqlError.SqlError, R>
): Effect.Effect<A, HttpServerResponse.HttpServerResponse, R> =>
  Effect.catchTags(eff, {
    AuthError: () =>
      Effect.fail(HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 as const })),
    InvalidCodeError: () =>
      Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid_code" }, { status: 400 as const })),
    InvalidResetTokenError: () =>
      Effect.fail(HttpServerResponse.jsonUnsafe({ error: "invalid_token" }, { status: 400 as const })),
    TooManyAttemptsError: (e) =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe(
          { error: "too_many_attempts", retryAfterSeconds: e.retryAfterSeconds },
          { status: 429 as const }
        )
      ),
    AuthEmailRateLimitedError: (e) =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe(
          { error: "rate_limited", retryAfterSeconds: e.retryAfterSeconds },
          { status: 429 as const }
        )
      ),
    EmailFlowDisabledError: () =>
      Effect.fail(HttpServerResponse.jsonUnsafe({ error: "not_found" }, { status: 404 as const })),
    EmailUnavailableError: () =>
      Effect.fail(
        HttpServerResponse.jsonUnsafe({ error: "email_unavailable" }, { status: 503 as const })
      ),
    ChallengeCryptoError: () =>
      Effect.fail(HttpServerResponse.jsonUnsafe({ error: "internal_error" }, { status: 500 as const })),
    SqlError: () =>
      Effect.fail(HttpServerResponse.jsonUnsafe({ error: "internal_error" }, { status: 500 as const }))
  })
