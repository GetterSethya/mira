import { assert, describe, it } from "@effect/vitest"
import { Config, ConfigProvider, Data, Effect, Layer, Result, Stream } from "effect"
import { Files as FilesClient } from "files-sdk"
import { make as makeFilesService } from "files-sdk/effect"
import { memory } from "files-sdk/memory"

import {
  makeFileStorageFromFiles,
  makeS3FileStorageLayer
} from "@/storage/s3-storage.js"
import { FileStorage } from "@/storage/storage.js"

/**
 * Storage layer over the in-memory `files-sdk` adapter — no network, no disk.
 */
const memoryStorageLayer = () =>
  Layer.succeed(
    FileStorage,
    makeFileStorageFromFiles(makeFilesService(new FilesClient({ adapter: memory() })))
  )

const bytes = (...values: Array<number>) => new Uint8Array(values)

const toStream = (data: Uint8Array): Stream.Stream<Uint8Array, never> => Stream.fromArray([data])

/** Local tagged error used to prove upstream stream failures survive upload. */
class UpstreamError extends Data.TaggedError("UpstreamError")<{ readonly detail: string }> {}

const s3Config = {
  endpoint: "https://s3.example.com/",
  bucketName: "mira",
  regionName: "us-east-1",
  accessKey: "access",
  secret: "secret",
}

describe("FileStorage (S3-compatible, memory adapter)", () => {
  it.effect("upload and read roundtrip", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const data = bytes(72, 101, 108, 108, 111) // "Hello"
      const key = yield* storage.upload("hello.txt", toStream(data), "text/plain")
      assert.strictEqual(key, "hello.txt")
      assert.deepStrictEqual(yield* storage.read("hello.txt"), data)
    }).pipe(Effect.provide(memoryStorageLayer()))
  )

  it.effect("read returns FileStorageNotFound for a missing key", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const result = yield* storage.read("ghost.txt").pipe(Effect.result)
      assert.ok(Result.isFailure(result))
      assert.strictEqual(result.failure._tag, "FileStorageNotFound")
    }).pipe(Effect.provide(memoryStorageLayer()))
  )

  it.effect("exists is true after upload and false for a missing key", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      yield* storage.upload("exists.bin", toStream(bytes(1, 2)), "application/octet-stream")
      assert.strictEqual(yield* storage.exists("exists.bin"), true)
      assert.strictEqual(yield* storage.exists("not-here.bin"), false)
    }).pipe(Effect.provide(memoryStorageLayer()))
  )

  it.effect("delete removes a file and is idempotent", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      yield* storage.upload("to-delete.txt", toStream(bytes(9)), "text/plain")
      yield* storage.delete("to-delete.txt")
      assert.strictEqual(yield* storage.exists("to-delete.txt"), false)
      // Deleting a key that never existed must not fail.
      yield* storage.delete("to-delete.txt")
    }).pipe(Effect.provide(memoryStorageLayer()))
  )

  it.effect("list returns full keys under a prefix", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      yield* storage.upload("_thumbs/img.jpg/100x100", toStream(bytes(1)), "image/jpeg")
      yield* storage.upload("_thumbs/img.jpg/200x200", toStream(bytes(2)), "image/jpeg")
      yield* storage.upload("other.jpg", toStream(bytes(3)), "image/jpeg")

      const keys = yield* storage.list("_thumbs/img.jpg/")
      assert.deepStrictEqual([...keys].sort(), [
        "_thumbs/img.jpg/100x100",
        "_thumbs/img.jpg/200x200",
      ])
    }).pipe(Effect.provide(memoryStorageLayer()))
  )

  it.effect("list returns an empty array for an unknown prefix", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      assert.deepStrictEqual(yield* storage.list("_thumbs/no-such-file/"), [])
    }).pipe(Effect.provide(memoryStorageLayer()))
  )

  it.effect("nested keys roundtrip", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      yield* storage.upload("a/b/c/nested.bin", toStream(bytes(42)), "application/octet-stream")
      assert.deepStrictEqual(yield* storage.read("a/b/c/nested.bin"), bytes(42))
    }).pipe(Effect.provide(memoryStorageLayer()))
  )

  it.effect("upload passes upstream stream errors through unchanged", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      const failing = Stream.concat(
        Stream.fromArray([bytes(1, 2, 3)]),
        Stream.fail(new UpstreamError({ detail: "upstream broke" }))
      )
      const result = yield* storage
        .upload("upstream.bin", failing, "application/octet-stream")
        .pipe(Effect.result)
      assert.ok(Result.isFailure(result))
      assert.strictEqual(result.failure._tag, "UpstreamError")
    }).pipe(Effect.provide(memoryStorageLayer()))
  )
})

describe("FileStorage (S3-compatible) url()", () => {
  it.effect("returns a path-style URL by default", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      assert.strictEqual(
        storage.url("uploads/a b/c.png"),
        "https://s3.example.com/mira/uploads/a%20b/c.png"
      )
    }).pipe(Effect.provide(makeS3FileStorageLayer(s3Config)))
  )

  it.effect("prefers publicBaseUrl when configured", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      assert.strictEqual(
        storage.url("uploads/a b/c.png"),
        "https://cdn.example.com/uploads/a%20b/c.png"
      )
    }).pipe(
      Effect.provide(
        makeS3FileStorageLayer({ ...s3Config, publicBaseUrl: "https://cdn.example.com/" })
      )
    )
  )

  it.effect("neutralises dot segments", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      assert.strictEqual(storage.url("../etc/passwd"), "https://s3.example.com/mira/etc/passwd")
    }).pipe(Effect.provide(makeS3FileStorageLayer(s3Config)))
  )

  it.effect("uses virtual-host addressing when forcePathStyle is false", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      assert.strictEqual(
        storage.url("uploads/c.png"),
        "https://mira.s3.example.com/uploads/c.png"
      )
    }).pipe(Effect.provide(makeS3FileStorageLayer({ ...s3Config, forcePathStyle: false })))
  )

  it.effect("resolves Config values with the ambient ConfigProvider", () =>
    Effect.gen(function* () {
      const storage = yield* FileStorage
      assert.strictEqual(
        storage.url("uploads/a b/c.png"),
        "https://cfg.example.com/mira-config/uploads/a%20b/c.png"
      )
    }).pipe(
      Effect.provide(
        makeS3FileStorageLayer({
          endpoint: Config.String("S3_ENDPOINT"),
          bucketName: Config.String("S3_BUCKET"),
          regionName: Config.succeed("us-east-1"),
          accessKey: Config.Redacted("S3_ACCESS_KEY"),
          secret: Config.Redacted("S3_SECRET"),
          forcePathStyle: Config.succeed(true)
        }).pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                S3_ENDPOINT: "https://cfg.example.com/",
                S3_BUCKET: "mira-config",
                S3_ACCESS_KEY: "cfg-access-key",
                S3_SECRET: "cfg-secret"
              })
            )
          )
        )
      )
    )
  )
})
