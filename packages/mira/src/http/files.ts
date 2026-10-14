import type { CollectionSchema } from "@gettersethya/mira-client"
import { Cause, Effect, Exit, Option, Ref, Stream } from "effect"
import type { HttpServerRequest } from "effect/http"
import * as Multipart from "effect/http/Multipart"

import { PayloadTooLargeError, ValidationError } from "@/collection-service/errors.js"
import { CryptoService } from "@/crypto/index.js"
import { FileStorage } from "@/storage/storage.js"

/**
 * Fallback maximum upload size applied when a file field does not declare an
 * `x-maxSize`. Any file field without an explicit cap still rejects uploads
 * larger than this (8 MiB).
 */
export const DEFAULT_MAX_FILE_SIZE = 8 * 1024 * 1024

/**
 * Hard ceiling for a single multipart request body, regardless of how many file
 * fields a collection declares (64 MiB).
 */
export const GLOBAL_MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/**
 * Allowance added to the sum of per-file budgets to cover multipart framing
 * (boundaries, part headers, field values). Keeps a request that is exactly
 * `Σ x-maxSize` of file content from being rejected on overhead alone (1 MiB).
 */
export const CONTENT_OVERHEAD_BYTES = 1024 * 1024

/** Maximum number of multipart parts accepted in one request. */
export const MAX_MULTIPART_PARTS = 64

/** Maximum byte length of a single non-file multipart field value. */
export const MAX_FIELD_SIZE = 64 * 1024

const utf8 = new TextEncoder()

/**
 * Request-level byte budget for a collection: the smaller of the global ceiling
 * and the content overhead plus the sum of every file field's own limit.
 */
export function uploadBudget(schema: CollectionSchema) {
  let filesBudget = 0
  for (const prop of Object.values(schema.properties)) {
    if (prop["x-kind"] === "file") {
      filesBudget += prop["x-maxSize"] ?? DEFAULT_MAX_FILE_SIZE
    }
  }
  return Math.min(GLOBAL_MAX_UPLOAD_BYTES, CONTENT_OVERHEAD_BYTES + filesBudget)
}

/**
 * Map a parser `MultipartError` to the closest domain error. Size and
 * part-count reasons surface as `PayloadTooLargeError` (413); every parse
 * problem (and an over-long form field) surfaces as `ValidationError` (422).
 */
function multipartErrorToCollectionError(
  collectionName: string,
  budget: number,
  error: Multipart.MultipartError
) {
  switch (error.reason._tag) {
    case "TooManyParts":
      return new PayloadTooLargeError({
        limit: MAX_MULTIPART_PARTS,
        detail: `Too many multipart parts (maximum ${MAX_MULTIPART_PARTS})`
      })
    case "BodyTooLarge":
      return new PayloadTooLargeError({
        limit: budget,
        detail: `Request body exceeds the ${budget}-byte upload budget`
      })
    case "FileTooLarge":
      return new PayloadTooLargeError({
        limit: budget,
        detail: `File part exceeds the ${budget}-byte upload budget`
      })
    case "FieldTooLarge":
      return new ValidationError({
        collection: collectionName,
        issues: [`A form field exceeds the ${MAX_FIELD_SIZE}-byte limit`]
      })
    case "Parse":
    case "InternalError":
      return new ValidationError({
        collection: collectionName,
        issues: [`Multipart parse error: ${error.message}`]
      })
  }
}

export const makeFileKey = (originalFilename: string) =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService
    const uuid = yield* crypto.randomUUID()
    const dotIdx = originalFilename.lastIndexOf(".")
    const ext = dotIdx !== -1 ? originalFilename.slice(dotIdx + 1) : "bin"
    return `${uuid}.${ext}`
  })

/**
 * Enforce a per-file `maxSize` while fully draining the stream, and account
 * every byte against the shared request budget.
 *
 * Once the per-file limit is crossed no further bytes are emitted to the sink
 * (a partial file is written, flagged via `exceeded`, and deleted by the
 * caller), but the remaining content is still consumed so the request body is
 * fully read and the connection is never left half-open. If the *request-wide*
 * total crosses `budget` the stream fails with `PayloadTooLargeError` (413) and
 * reading stops.
 */
function withSizeLimit<E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxSize: number,
  exceeded: Ref.Ref<boolean>,
  requestBytes: Ref.Ref<number>,
  budget: number
) {
  return stream.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (total, chunk) =>
        Effect.gen(function* () {
          const requestTotal = yield* Ref.updateAndGet(requestBytes, (n) => n + chunk.byteLength)
          if (requestTotal > budget) {
            return yield* new PayloadTooLargeError({
              limit: budget,
              detail: `Request body exceeds the ${budget}-byte upload budget`
            })
          }
          const next = total + chunk.byteLength
          if (next > maxSize) {
            yield* Ref.set(exceeded, true)
            const discarded: readonly [number, ReadonlyArray<Uint8Array>] = [next, []]
            return discarded
          }
          const pair: readonly [number, ReadonlyArray<Uint8Array>] = [next, [chunk]]
          return pair
        })
    )
  )
}

export function processMultipartUpload(
  request: HttpServerRequest.HttpServerRequest,
  schema: CollectionSchema,
  collectionName: string
) {
  return Effect.gen(function* () {
    const ct = request.headers["content-type"] ?? ""
    if (!ct.includes("multipart/form-data")) {
      return yield* new ValidationError({
        collection: collectionName,
        issues: ["Expected multipart/form-data content type"]
      })
    }

    const budget = uploadBudget(schema)

    // Reject an over-budget body from its declared length before reading a
    // single byte.
    const declared = Number(request.headers["content-length"] ?? "")
    if (Number.isFinite(declared) && declared > budget) {
      return yield* new PayloadTooLargeError({
        limit: budget,
        detail: `Declared request size ${declared} bytes exceeds the ${budget}-byte upload budget`
      })
    }

    const fields: Record<string, string> = {}
    const fileKeys: Record<string, string> = {}
    const fileStorage = yield* FileStorage
    const violation = yield* Ref.make<{ field: string; maxSize: number } | null>(null)
    // Every key allocated during the request. On any failure or interruption
    // (including a client disconnect) all of them are removed, so a partial or
    // aborted upload never leaves orphaned files behind.
    const createdKeys = yield* Ref.make<ReadonlyArray<string>>([])
    const requestBytes = yield* Ref.make(0)

    const deleteCreated = Ref.get(createdKeys).pipe(
      Effect.flatMap((keys) =>
        Effect.forEach(
          keys,
          (key) => fileStorage.delete(key).pipe(Effect.catch(() => Effect.void)),
          { concurrency: "unbounded" }
        )
      )
    )

    const parse = Effect.gen(function* () {
      yield* Stream.runForEach(
        request.multipartStream.pipe(
          Stream.mapError((e) => multipartErrorToCollectionError(collectionName, budget, e))
        ),
        (part) =>
          Effect.gen(function* () {
            if (Multipart.isFile(part)) {
              const prop = schema.properties[part.key]
              if (prop === undefined) {
                return yield* new ValidationError({
                  collection: collectionName,
                  issues: [`Field "${part.key}" does not exist on collection "${collectionName}"`]
                })
              }
              if (prop["x-kind"] !== "file") {
                return yield* new ValidationError({
                  collection: collectionName,
                  issues: [`Field "${part.key}" is not a file field`]
                })
              }

              const allowedMimes = prop["x-mimeTypes"]
              if (
                allowedMimes !== undefined &&
                allowedMimes.length > 0 &&
                !allowedMimes.includes(part.contentType)
              ) {
                return yield* new ValidationError({
                  collection: collectionName,
                  issues: [
                    `File on field "${part.key}" has unsupported MIME type "${part.contentType}". Allowed: ${allowedMimes.join(", ")}`
                  ]
                })
              }

              const key = yield* makeFileKey(part.name)
              yield* Ref.update(createdKeys, (ks) => [...ks, key])
              const mappedContent = part.content.pipe(
                Stream.mapError((e) => multipartErrorToCollectionError(collectionName, budget, e))
              )

              const maxSize = prop["x-maxSize"] ?? DEFAULT_MAX_FILE_SIZE
              const exceeded = yield* Ref.make(false)
              const uploadStream = withSizeLimit(mappedContent, maxSize, exceeded, requestBytes, budget)

              yield* fileStorage.upload(key, uploadStream, part.contentType)

              const overLimit = yield* Ref.get(exceeded)
              if (overLimit) {
                yield* fileStorage.delete(key).pipe(Effect.catch(() => Effect.void))
                yield* Ref.update(violation, (v) => (v === null ? { field: part.key, maxSize } : v))
              } else {
                fileKeys[part.key] = key
              }
            } else if (Multipart.isField(part)) {
              const bytes = utf8.encode(part.value).byteLength
              const requestTotal = yield* Ref.updateAndGet(requestBytes, (n) => n + bytes)
              if (bytes > MAX_FIELD_SIZE) {
                return yield* new ValidationError({
                  collection: collectionName,
                  issues: [`Field "${part.key}" exceeds the ${MAX_FIELD_SIZE}-byte limit`]
                })
              }
              if (requestTotal > budget) {
                return yield* new PayloadTooLargeError({
                  limit: budget,
                  detail: `Request body exceeds the ${budget}-byte upload budget`
                })
              }
              fields[part.key] = part.value
            }
          })
      )

      const violationEntry = yield* Ref.get(violation)
      if (violationEntry !== null) {
        return yield* new ValidationError({
          collection: collectionName,
          issues: [
            `File on field "${violationEntry.field}" exceeds maximum size of ${violationEntry.maxSize} bytes`
          ]
        })
      }

      return { ...fields, ...fileKeys }
    }).pipe(
      // A missing/empty multipart boundary surfaces as an untyped defect (the
      // parser dies) rather than a typed stream error. Convert any unhandled
      // cause into a `ValidationError` so the HTTP layer answers 422, not 500.
      Effect.catchCause((cause) => {
        const failure = Cause.findErrorOption(cause)
        if (Option.isSome(failure)) {
          return Effect.fail(failure.value)
        }
        return Effect.fail(
          new ValidationError({
            collection: collectionName,
            issues: ["Malformed multipart body (missing boundary)"]
          })
        )
      })
    )

    // Clean up every allocated file on any failure or interruption, but keep
    // them on success.
    return yield* parse.pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? deleteCreated : Effect.void))
    )
  }).pipe(
    Effect.provideContext(
      Multipart.limitsServices({
        maxParts: MAX_MULTIPART_PARTS,
        maxFieldSize: MAX_FIELD_SIZE
      })
    )
  )
}
