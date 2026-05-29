import { FileSystem, Path } from "@effect/platform"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Chunk, Effect, Either, Layer, Scope, Stream } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { FileStorage, makeFileStorageLayer } from "@/storage/storage.js"
import { NodeCryptoLayer } from "@/crypto/node.js"

const nodePlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCryptoLayer)

function withTempDir<A, E>(
  body: (storageLayer: Layer.Layer<FileStorage, never, FileSystem.FileSystem | Path.Path>) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
): Effect.Effect<A, E, Scope.Scope> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped().pipe(Effect.orDie)
    const storageLayer = makeFileStorageLayer("local", { directory: dir })
    return yield* body(storageLayer)
  }).pipe(Effect.provide(nodePlatformLayer))
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function toStream(data: Uint8Array): Stream.Stream<Uint8Array, never> {
  return Stream.fromChunk(Chunk.of(data))
}

describe("FileStorage (local)", () => {
  it.scoped("upload and read roundtrip", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        const data = bytes(72, 101, 108, 108, 111) // "Hello"
        yield* storage.upload("hello.txt", toStream(data), "text/plain")
        const result = yield* storage.read("hello.txt")
        assert.deepStrictEqual(result, data)
      }).pipe(Effect.provide(layer))
    )
  )

  it.scoped("read returns FileStorageNotFound for missing key", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        const result = yield* storage.read("ghost.txt").pipe(Effect.either)
        assert.ok(Either.isLeft(result))
        assert.strictEqual(result.left._tag, "FileStorageNotFound")
      }).pipe(Effect.provide(layer))
    )
  )

  it.scoped("exists returns true for an uploaded key", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        yield* storage.upload("exists.bin", toStream(bytes(1, 2)), "application/octet-stream")
        const yes = yield* storage.exists("exists.bin")
        assert.strictEqual(yes, true)
      }).pipe(Effect.provide(layer))
    )
  )

  it.scoped("exists returns false for a missing key", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        const no = yield* storage.exists("not-here.bin")
        assert.strictEqual(no, false)
      }).pipe(Effect.provide(layer))
    )
  )

  it.scoped("delete removes a file and exists returns false", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        yield* storage.upload("to-delete.txt", toStream(bytes(9)), "text/plain")
        yield* storage.delete("to-delete.txt")
        const exists = yield* storage.exists("to-delete.txt")
        assert.strictEqual(exists, false)
      }).pipe(Effect.provide(layer))
    )
  )

  it.scoped("list returns keys under a prefix", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        yield* storage.upload("_thumbs/img.jpg/100x100", toStream(bytes(1)), "image/jpeg")
        yield* storage.upload("_thumbs/img.jpg/200x200", toStream(bytes(2)), "image/jpeg")
        yield* storage.upload("other.jpg", toStream(bytes(3)), "image/jpeg")

        const keys = yield* storage.list("_thumbs/img.jpg/")
        assert.strictEqual(keys.length, 2)
        assert.ok(keys.includes("_thumbs/img.jpg/100x100"))
        assert.ok(keys.includes("_thumbs/img.jpg/200x200"))
      }).pipe(Effect.provide(layer))
    )
  )

  it.scoped("list returns empty array for non-existent prefix", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        const keys = yield* storage.list("_thumbs/no-such-file/")
        assert.deepStrictEqual(keys, [])
      }).pipe(Effect.provide(layer))
    )
  )

  it.scoped("upload creates nested directories as needed", () =>
    withTempDir((layer) =>
      Effect.gen(function* () {
        const storage = yield* FileStorage
        yield* storage.upload("a/b/c/nested.bin", toStream(bytes(42)), "application/octet-stream")
        const result = yield* storage.read("a/b/c/nested.bin")
        assert.deepStrictEqual(result, bytes(42))
      }).pipe(Effect.provide(layer))
    )
  )
})
