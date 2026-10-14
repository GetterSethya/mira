import { FileSystem, Path } from "effect"
import { Context, Data, Effect, Layer, Result, Stream } from "effect"

/**
 * Error raised when a file storage operation fails (disk I/O, permission issues, etc.).
 *
 * @example
 * new FileStorageError({ reason: "ENOSPC: no space left on device" })
 */
export class FileStorageError extends Data.TaggedError("FileStorageError")<{
  reason: string
}> {}

/**
 * Error raised when a requested file does not exist in storage.
 *
 * @example
 * new FileStorageNotFound({ key: "uploads/abc123/image.jpg" })
 */
export class FileStorageNotFound extends Data.TaggedError("FileStorageNotFound")<{
  key: string
}> {}

/**
 * Structural guard for the platform error surfaced by `FileSystem`/`Path`
 * operations. Used to remap only the file sink's own errors while leaving the
 * caller's stream errors (`E`) untouched — `Effect.catchTag` cannot narrow a
 * generic error channel, so we discriminate on the `_tag` string here.
 */
const isPlatformError = (
  u: unknown
): u is { readonly _tag: "PlatformError"; readonly message: string } =>
  typeof u === "object" && u !== null && "_tag" in u && u._tag === "PlatformError"

/**
 * File storage abstraction tag.
 *
 * Provides `upload`, `delete`, `url`, `read`, `exists`, and `list` operations
 * for file management. The concrete implementation can be local disk or S3.
 *
 * All operations return `Effect` with typed error channels.
 *
 * @example
 * import { FileStorage } from "@gettersethya/mira"
 *
 * Effect.gen(function* () {
 *   const storage = yield* FileStorage
 *   const key = yield* storage.upload("path/to/file", stream, "image/jpeg")
 *   const url = storage.url(key)  // synchronous — returns the URL string
 *   const data = yield* storage.read(key)
 *   const exists = yield* storage.exists(key)
 *   const files = yield* storage.list("uploads/")
 *   yield* storage.delete(key)
 * })
 *
 * @see makeFileStorageLayer — factory function
 * @see LocalFileStorage — local disk preset
 */
export class FileStorage extends Context.Service<
  FileStorage,
  {
    upload<E>(
      key: string,
      stream: Stream.Stream<Uint8Array, E>,
      mimeType: string
    ): Effect.Effect<string, E | FileStorageError>
    delete(key: string): Effect.Effect<void, FileStorageError>
    url(key: string): string
    read(key: string): Effect.Effect<Uint8Array, FileStorageError | FileStorageNotFound>
    exists(key: string): Effect.Effect<boolean, FileStorageError>
    list(prefix: string): Effect.Effect<ReadonlyArray<string>, FileStorageError>
  }
>()("FileStorage") {}

/**
 * Create a FileStorage layer backed by the local filesystem.
 *
 * Files are stored under a root directory (default: `./uploads`).
 * Nested subdirectories are created automatically based on the key path.
 *
 * Note: the `_provider` parameter is currently unused and reserved for future
 * provider detection. Pass `"local"` for now.
 *
 * @param _provider - Provider type (currently unused, pass "local")
 * @param config.directory - Storage root directory (default: "./uploads")
 * @returns A Layer providing FileStorage
 *
 * @example
 * makeFileStorageLayer("local", { directory: "/var/data/uploads" })
 *
 * @see LocalFileStorage — preset wrapping this function
 */
export function makeFileStorageLayer(_provider: string, config: Record<string, string>) {
  return Layer.effect(
    FileStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pathSvc = yield* Path.Path
      const root = config["directory"] ?? "./uploads"

      /**
       * Resolve `key` against the storage `root` and return the contained
       * absolute path, or `undefined` when the key is not contained. Both sides
       * are fully resolved first so `.`, `..`, redundant separators and mixed
       * (`/` vs `\`) separators are normalised.
       */
      const containedPath = (key: string): string | undefined => {
        const rootAbs = pathSvc.resolve(root)
        const target = pathSvc.resolve(pathSvc.join(root, key))
        const rel = pathSvc.relative(rootAbs, target)
        if (rel.startsWith("..") || pathSvc.isAbsolute(rel)) {
          return undefined
        }
        return target
      }

      return FileStorage.of({
        upload: <E>(key: string, stream: Stream.Stream<Uint8Array, E>, _mimeType: string) =>
          Effect.gen(function* () {
            const fullPath = containedPath(key)
            if (fullPath === undefined) {
              return yield* new FileStorageError({ reason: `Refusing to write outside storage root: ${key}` })
            }
            yield* fs.makeDirectory(pathSvc.dirname(fullPath), { recursive: true }).pipe(
              Effect.catchTag("PlatformError", (e) => Effect.fail(new FileStorageError({ reason: e.message })))
            )
            // `Sink.mapError` (and `catchTag` over the generic stream error `E`)
            // cannot be used here: mapping at the sink rewrites errors coming
            // from the *upstream* stream too, which would turn the upload
            // size-limit `ValidationError` into a `FileStorageError` (502).
            // Instead run, then remap only the sink's own `PlatformError`,
            // passing every upstream error through untouched.
            const outcome = yield* Effect.result(Stream.run(stream, fs.sink(fullPath)))
            if (Result.isFailure(outcome)) {
              const error = outcome.failure
              if (isPlatformError(error)) {
                return yield* new FileStorageError({ reason: error.message })
              }
              return yield* Effect.fail(error)
            }
            return key
          }),

        delete: (key: string) =>
          Effect.gen(function* () {
            const fullPath = containedPath(key)
            if (fullPath === undefined) {
              return yield* new FileStorageError({ reason: `Refusing to delete outside storage root: ${key}` })
            }
            yield* fs.remove(fullPath, { force: true }).pipe(
              Effect.catchTag("PlatformError", (e) => Effect.fail(new FileStorageError({ reason: e.message })))
            )
          }),

        url: (key: string) => `/files/${key}`,

        read: (key: string) =>
          Effect.gen(function* () {
            const fullPath = containedPath(key)
            if (fullPath === undefined) {
              return yield* new FileStorageNotFound({ key })
            }
            const present = yield* fs.exists(fullPath).pipe(
              Effect.catchTag("PlatformError", () => Effect.succeed(false))
            )
            if (!present) return yield* new FileStorageNotFound({ key })
            return yield* fs.readFile(fullPath).pipe(
              Effect.catchTag("PlatformError", (e) => Effect.fail(new FileStorageError({ reason: e.message })))
            )
          }),

        exists: (key: string) =>
          Effect.gen(function* () {
            const fullPath = containedPath(key)
            if (fullPath === undefined) {
              return yield* new FileStorageError({ reason: `Refusing to probe outside storage root: ${key}` })
            }
            return yield* fs.exists(fullPath).pipe(
              Effect.catchTag("PlatformError", () => Effect.succeed(false))
            )
          }),

        list: (prefix: string) =>
          Effect.gen(function* () {
            const prefixPath = containedPath(prefix)
            if (prefixPath === undefined) {
              return yield* new FileStorageError({ reason: `Refusing to list outside storage root: ${prefix}` })
            }
            const entries = yield* fs.readDirectory(prefixPath, { recursive: true }).pipe(
              Effect.catchTag("PlatformError", () => Effect.succeed<Array<string>>([]))
            )
            const fileEntries = yield* Effect.filter(
              entries,
              (entry) =>
                fs.stat(pathSvc.join(prefixPath, entry)).pipe(
                  Effect.map((info) => info.type === "File"),
                  Effect.orElseSucceed(() => false)
                ),
              { concurrency: "unbounded" }
            )
            return fileEntries.map((entry) =>
              pathSvc.join(prefix, entry).split(pathSvc.sep).join("/")
            )
          })
      })
    })
  )
}
