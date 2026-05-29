import { HttpServerRequest } from "@effect/platform"
import * as Multipart from "@effect/platform/Multipart"
import { Effect, Stream } from "effect"
import { CryptoService } from "@/crypto/index.js"
import type { CollectionSchema } from "@gettersethya/mira-client"
import { ValidationError } from "@/collection-service/errors.js"
import { FileStorage } from "@/storage/storage.js"

export const makeFileKey = (originalFilename: string) =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService
    const uuid = yield* crypto.randomUUID()
    const dotIdx = originalFilename.lastIndexOf(".")
    const ext = dotIdx !== -1 ? originalFilename.slice(dotIdx + 1) : "bin"
    return `${uuid}.${ext}`
  })

function withSizeLimit<E>(stream: Stream.Stream<Uint8Array, E>, maxSize: number, field: string, collection: string) {
  return stream.pipe(
    Stream.mapAccumEffect(0, (total, chunk) => {
      const next = total + chunk.byteLength
      if (next > maxSize) {
        return Effect.fail(
          new ValidationError({
            collection,
            issues: [`File on field "${field}" exceeds maximum size of ${maxSize} bytes`]
          })
        )
      }
      const pair: readonly [number, Uint8Array] = [next, chunk]
      return Effect.succeed(pair)
    })
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

    const fields: Record<string, string> = {}
    const fileKeys: Record<string, string> = {}
    const fileStorage = yield* FileStorage

    yield* Stream.runForEach(
      request.multipartStream.pipe(
        Stream.mapError(
          (e) =>
            new ValidationError({
              collection: collectionName,
              issues: [`Multipart parse error: ${e.message}`]
            })
        )
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
            if (allowedMimes !== undefined && allowedMimes.length > 0 && !allowedMimes.includes(part.contentType)) {
              return yield* new ValidationError({
                collection: collectionName,
                issues: [
                  `File on field "${part.key}" has unsupported MIME type "${part.contentType}". Allowed: ${allowedMimes.join(", ")}`
                ]
              })
            }

            const key = yield* makeFileKey(part.name)
            const mappedContent = part.content.pipe(
              Stream.mapError(
                (e) =>
                  new ValidationError({
                    collection: collectionName,
                    issues: [`Failed to read file "${part.key}": ${e.message}`]
                  })
              )
            )

            const uploadStream =
              prop["x-maxSize"] !== undefined
                ? withSizeLimit(mappedContent, prop["x-maxSize"], part.key, collectionName)
                : mappedContent

            yield* fileStorage
              .upload(key, uploadStream, part.contentType)
              .pipe(Effect.onError(() => fileStorage.delete(key).pipe(Effect.orElse(() => Effect.void))))

            fileKeys[part.key] = key
          } else if (Multipart.isField(part)) {
            fields[part.key] = part.value
          }
        })
    )

    return { ...fields, ...fileKeys }
  })
}
