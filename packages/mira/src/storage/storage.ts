import { FileSystem, Path } from "@effect/platform"
import { Context, Data, Effect, Layer, Sink, Stream } from "effect"

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
export class FileStorage extends Context.Tag("FileStorage")<
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
>() {}

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

      return FileStorage.of({
        upload: <E>(key: string, stream: Stream.Stream<Uint8Array, E>, _mimeType: string) =>
          Effect.gen(function* () {
            const fullPath = pathSvc.join(root, key)
            yield* fs.makeDirectory(pathSvc.dirname(fullPath), { recursive: true }).pipe(
              Effect.catchTags({
                BadArgument: (e) => Effect.fail(new FileStorageError({ reason: e.message })),
                SystemError: (e) => Effect.fail(new FileStorageError({ reason: e.message }))
              })
            )
            // Map PlatformError at the sink level so generic E is not involved
            const mappedSink = Sink.mapError(
              fs.sink(fullPath),
              (e) => new FileStorageError({ reason: e.message ?? String(e) })
            )
            yield* Stream.run(stream, mappedSink)
            return key
          }),

        delete: (key: string) =>
          Effect.gen(function* () {
            const fullPath = pathSvc.join(root, key)
            yield* fs.remove(fullPath, { force: true }).pipe(
              Effect.catchTags({
                BadArgument: (e) => Effect.fail(new FileStorageError({ reason: e.message })),
                SystemError: (e) => Effect.fail(new FileStorageError({ reason: e.message }))
              })
            )
          }),

        url: (key: string) => `/files/${key}`,

        read: (key: string) =>
          Effect.gen(function* () {
            const fullPath = pathSvc.join(root, key)
            const present = yield* fs.exists(fullPath).pipe(
              Effect.catchTags({
                BadArgument: () => Effect.succeed(false),
                SystemError: () => Effect.succeed(false)
              })
            )
            if (!present) return yield* new FileStorageNotFound({ key })
            return yield* fs.readFile(fullPath).pipe(
              Effect.catchTags({
                BadArgument: (e) => Effect.fail(new FileStorageError({ reason: e.message })),
                SystemError: (e) => Effect.fail(new FileStorageError({ reason: e.message }))
              })
            )
          }),

        exists: (key: string) =>
          Effect.gen(function* () {
            const fullPath = pathSvc.join(root, key)
            return yield* fs.exists(fullPath).pipe(
              Effect.catchTags({
                BadArgument: () => Effect.succeed(false),
                SystemError: () => Effect.succeed(false)
              })
            )
          }),

        list: (prefix: string) =>
          Effect.gen(function* () {
            const prefixPath = pathSvc.join(root, prefix)
            const entries = yield* fs.readDirectory(prefixPath, { recursive: true }).pipe(
              Effect.catchTags({
                BadArgument: () => Effect.succeed<string[]>([]),
                SystemError: () => Effect.succeed<string[]>([])
              })
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
            ) as ReadonlyArray<string>
          })
      })
    })
  )
}
