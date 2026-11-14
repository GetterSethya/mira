import { deflateSync } from "node:zlib"

import { PhotonImage } from "@cf-wasm/photon/node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import {
  assertImageWithinPixelBudget,
  makeThumbnailServicePhotonLive,
  readImageDimensions,
  ThumbnailService
} from "@/thumbnail/index.js"

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function toBytes(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function makePng(width: number, height: number): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdrData = new Uint8Array(13)
  ihdrData.set(toBytes(width), 0)
  ihdrData.set(toBytes(height), 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  const ihdrType = new TextEncoder().encode("IHDR")
  const ihdrChunk = new Uint8Array(4 + 4 + ihdrData.length + 4)
  ihdrChunk.set(toBytes(ihdrData.length), 0)
  ihdrChunk.set(ihdrType, 4)
  ihdrChunk.set(ihdrData, 8)
  ihdrChunk.set(toBytes(crc32(new Uint8Array([...ihdrType, ...ihdrData]))), 8 + ihdrData.length)

  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 3
      raw[px] = 40
      raw[px + 1] = 80
      raw[px + 2] = 120
    }
  }
  const compressed = deflateSync(raw)
  const idatType = new TextEncoder().encode("IDAT")
  const idatChunk = new Uint8Array(4 + 4 + compressed.length + 4)
  idatChunk.set(toBytes(compressed.length), 0)
  idatChunk.set(idatType, 4)
  idatChunk.set(compressed, 8)
  idatChunk.set(toBytes(crc32(new Uint8Array([...idatType, ...compressed]))), 8 + compressed.length)

  const iendType = new TextEncoder().encode("IEND")
  const iendChunk = new Uint8Array(4 + 4 + 0 + 4)
  iendChunk.set(toBytes(0), 0)
  iendChunk.set(iendType, 4)
  iendChunk.set(toBytes(crc32(iendType)), 8)

  const result = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  )
  let offset = 0
  result.set(signature, offset)
  offset += signature.length
  result.set(ihdrChunk, offset)
  offset += ihdrChunk.length
  result.set(idatChunk, offset)
  offset += idatChunk.length
  result.set(iendChunk, offset)
  return result
}

function encodeWithPhoton(png: Uint8Array, format: "jpeg" | "webp"): Uint8Array {
  const image = PhotonImage.new_from_byteslice(png)
  try {
    return format === "jpeg" ? image.get_bytes_jpeg(85) : image.get_bytes_webp()
  } finally {
    image.free()
  }
}

describe("readImageDimensions", () => {
  it("reads PNG dimensions from IHDR", () => {
    assert.deepStrictEqual(readImageDimensions(makePng(80, 60)), {
      width: 80,
      height: 60,
      format: "png"
    })
  })

  it("reads JPEG dimensions from the SOF segment", () => {
    const jpeg = encodeWithPhoton(makePng(20, 10), "jpeg")
    const dimensions = readImageDimensions(jpeg)
    assert.ok(dimensions !== null)
    assert.strictEqual(dimensions.width, 20)
    assert.strictEqual(dimensions.height, 10)
    assert.strictEqual(dimensions.format, "jpeg")
  })

  it("reads WebP dimensions from VP8/VP8L/VP8X", () => {
    const webp = encodeWithPhoton(makePng(20, 10), "webp")
    const dimensions = readImageDimensions(webp)
    assert.ok(dimensions !== null)
    assert.strictEqual(dimensions.width, 20)
    assert.strictEqual(dimensions.height, 10)
    assert.strictEqual(dimensions.format, "webp")
  })

  it("returns null for garbage", () => {
    assert.strictEqual(readImageDimensions(new Uint8Array([1, 2, 3])), null)
    assert.strictEqual(readImageDimensions(new Uint8Array(64)), null)
  })
})

describe("assertImageWithinPixelBudget", () => {
  it.effect("accepts an image within the budget", () =>
    Effect.gen(function* () {
      const dimensions = yield* assertImageWithinPixelBudget(makePng(80, 60), 80 * 60)
      assert.strictEqual(dimensions.width, 80)
      assert.strictEqual(dimensions.height, 60)
    })
  )

  it.effect("rejects an image over the budget", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(assertImageWithinPixelBudget(makePng(100, 100), 1_000))
      assert.ok(Result.isFailure(result))
      assert.strictEqual(result.failure._tag, "ThumbnailError")
    })
  )

  it.effect("rejects a garbage header", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(assertImageWithinPixelBudget(new Uint8Array(64), 1_000))
      assert.ok(Result.isFailure(result))
    })
  )
})

describe("makeThumbnailServicePhotonLive pixel budget", () => {
  it.effect("rejects a bomb before Photon decodes it", () =>
    Effect.gen(function* () {
      const service = yield* ThumbnailService
      const result = yield* Effect.result(
        service.resize(makePng(100, 100), "image/png", {
          width: 10,
          height: 10,
          fit: "fill"
        })
      )
      assert.ok(Result.isFailure(result))
      assert.strictEqual(result.failure._tag, "ThumbnailError")
    }).pipe(Effect.provide(makeThumbnailServicePhotonLive({ maxPixels: 1_000 })))
  )
})
