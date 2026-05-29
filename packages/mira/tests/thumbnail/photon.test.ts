import { PhotonImage } from "@cf-wasm/photon/node"
import { Effect, Either } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { ThumbnailService, ThumbnailServicePhotonLive } from "@/thumbnail/index.js"
import { computeDimensions } from "@/thumbnail/photon.js"
import { deflateSync } from "node:zlib"

function crc32(buf: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function toBytes(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF])
}

function makePng(width: number, height: number, fillR: number, fillG: number, fillB: number): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = new Uint8Array(13)
  ihdrData.set(toBytes(width), 0)
  ihdrData.set(toBytes(height), 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdrType = new TextEncoder().encode("IHDR")
  const ihdrChunk = new Uint8Array(4 + 4 + ihdrData.length + 4)
  ihdrChunk.set(toBytes(ihdrData.length), 0)
  ihdrChunk.set(ihdrType, 4)
  ihdrChunk.set(ihdrData, 8)
  ihdrChunk.set(toBytes(crc32(new Uint8Array([...ihdrType, ...ihdrData]))), 8 + ihdrData.length)

  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 3
      raw[px] = fillR
      raw[px + 1] = fillG
      raw[px + 2] = fillB
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

  const result = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length)
  let offset = 0
  result.set(signature, offset); offset += signature.length
  result.set(ihdrChunk, offset); offset += ihdrChunk.length
  result.set(idatChunk, offset); offset += idatChunk.length
  result.set(iendChunk, offset)
  return result
}

function makeJpeg(width: number, height: number): Uint8Array {
  const png = makePng(width, height, 0, 128, 255)
  const img = PhotonImage.new_from_byteslice(png)
  const jpeg = img.get_bytes_jpeg(85)
  img.free()
  return jpeg
}

function makeWebp(width: number, height: number): Uint8Array {
  const png = makePng(width, height, 255, 0, 0)
  const img = PhotonImage.new_from_byteslice(png)
  const webp = img.get_bytes_webp()
  img.free()
  return webp
}

function makeSplitPng(
  width: number,
  height: number,
  splitX: number,
  leftR: number, leftG: number, leftB: number,
  rightR: number, rightG: number, rightB: number
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = new Uint8Array(13)
  ihdrData.set(toBytes(width), 0)
  ihdrData.set(toBytes(height), 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdrType = new TextEncoder().encode("IHDR")
  const ihdrChunk = new Uint8Array(4 + 4 + ihdrData.length + 4)
  ihdrChunk.set(toBytes(ihdrData.length), 0)
  ihdrChunk.set(ihdrType, 4)
  ihdrChunk.set(ihdrData, 8)
  ihdrChunk.set(toBytes(crc32(new Uint8Array([...ihdrType, ...ihdrData]))), 8 + ihdrData.length)

  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 3
      raw[px] = x < splitX ? leftR : rightR
      raw[px + 1] = x < splitX ? leftG : rightG
      raw[px + 2] = x < splitX ? leftB : rightB
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

  const result = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length)
  let offset = 0
  result.set(signature, offset); offset += signature.length
  result.set(ihdrChunk, offset); offset += ihdrChunk.length
  result.set(idatChunk, offset); offset += idatChunk.length
  result.set(iendChunk, offset)
  return result
}

function makeRowSplitPng(
  width: number,
  height: number,
  splitY: number,
  topR: number, topG: number, topB: number,
  bottomR: number, bottomG: number, bottomB: number
): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = new Uint8Array(13)
  ihdrData.set(toBytes(width), 0)
  ihdrData.set(toBytes(height), 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdrType = new TextEncoder().encode("IHDR")
  const ihdrChunk = new Uint8Array(4 + 4 + ihdrData.length + 4)
  ihdrChunk.set(toBytes(ihdrData.length), 0)
  ihdrChunk.set(ihdrType, 4)
  ihdrChunk.set(ihdrData, 8)
  ihdrChunk.set(toBytes(crc32(new Uint8Array([...ihdrType, ...ihdrData]))), 8 + ihdrData.length)

  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    const r = y < splitY ? topR : bottomR
    const g = y < splitY ? topG : bottomG
    const b = y < splitY ? topB : bottomB
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 3
      raw[px] = r
      raw[px + 1] = g
      raw[px + 2] = b
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

  const result = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length)
  let offset = 0
  result.set(signature, offset); offset += signature.length
  result.set(ihdrChunk, offset); offset += ihdrChunk.length
  result.set(idatChunk, offset); offset += idatChunk.length
  result.set(iendChunk, offset)
  return result
}

describe("computeDimensions", () => {
  it("fill returns exact spec", () => {
    assert.deepStrictEqual(computeDimensions(1600, 900, { width: 300, height: 200, fit: "fill" }), { width: 300, height: 200 })
  })

  it("both zero axes returns original dims", () => {
    assert.deepStrictEqual(computeDimensions(1600, 900, { width: 0, height: 0, fit: "cover" }), { width: 1600, height: 900 })
  })

  it("zero-width with contain computes from aspect ratio", () => {
    const result = computeDimensions(1600, 900, { width: 0, height: 200, fit: "contain" })
    assert.strictEqual(result.height, 200)
    assert.strictEqual(result.width, Math.round(200 * (1600 / 900)))
  })

  it("zero-height with contain computes from aspect ratio", () => {
    const result = computeDimensions(1600, 900, { width: 100, height: 0, fit: "contain" })
    assert.strictEqual(result.width, 100)
    assert.strictEqual(result.height, Math.round(100 * (900 / 1600)))
  })

  it("zero-width with cover computes from aspect ratio", () => {
    const result = computeDimensions(1600, 900, { width: 0, height: 200, fit: "cover" })
    assert.strictEqual(result.height, 200)
    assert.strictEqual(result.width, Math.round(200 * (1600 / 900)))
  })

  it("zero-height with cover computes from aspect ratio", () => {
    const result = computeDimensions(1600, 900, { width: 100, height: 0, fit: "cover" })
    assert.strictEqual(result.width, 100)
    assert.strictEqual(result.height, Math.round(100 * (900 / 1600)))
  })

  it("cover scales up to the larger axis", () => {
    const result = computeDimensions(1600, 900, { width: 300, height: 200, fit: "cover" })
    assert.strictEqual(result.width, Math.ceil(1600 * (200 / 900)))
    assert.strictEqual(result.height, 200)
  })

  it("contain scales down to the smaller axis", () => {
    const result = computeDimensions(1600, 900, { width: 300, height: 200, fit: "contain" })
    const scale = 300 / 1600
    assert.strictEqual(result.width, Math.round(1600 * scale))
    assert.strictEqual(result.height, Math.round(900 * scale))
  })

  it("extreme tall aspect ratio does not produce zero width", () => {
    const result = computeDimensions(1, 100, { width: 0, height: 1, fit: "cover" })
    assert.strictEqual(result.width, 1)
    assert.strictEqual(result.height, 1)
  })

  it("extreme wide aspect ratio does not produce zero height", () => {
    const result = computeDimensions(100, 1, { width: 1, height: 0, fit: "cover" })
    assert.strictEqual(result.width, 1)
    assert.strictEqual(result.height, 1)
  })

  it("fill with zero-width uses imgWidth (not proportional)", () => {
    const result = computeDimensions(1600, 900, { width: 0, height: 200, fit: "fill" })
    assert.strictEqual(result.width, 1600)
    assert.strictEqual(result.height, 200)
  })

  it("fill with zero-height uses imgHeight (not proportional)", () => {
    const result = computeDimensions(1600, 900, { width: 300, height: 0, fit: "fill" })
    assert.strictEqual(result.width, 300)
    assert.strictEqual(result.height, 900)
  })
})

const PhotonLiveLayer = ThumbnailServicePhotonLive

describe("ThumbnailServicePhotonLive — supported()", () => {
  it.scoped("returns true for image/jpeg", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      assert.ok(svc.supported("image/jpeg"))
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("returns true for image/png", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      assert.ok(svc.supported("image/png"))
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("returns true for image/webp", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      assert.ok(svc.supported("image/webp"))
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("returns false for image/gif (regression guard)", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      assert.strictEqual(svc.supported("image/gif"), false)
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("returns false for image/avif (regression guard)", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      assert.strictEqual(svc.supported("image/avif"), false)
    }).pipe(Effect.provide(PhotonLiveLayer))
  )
})

describe("ThumbnailServicePhotonLive — resize PNG", () => {
  it.scoped("resize PNG with cover fit produces correct output dimensions", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(80, 60, 0, 200, 100)
      const result = yield* svc.resize(png, "image/png", { width: 40, height: 30, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 40)
      assert.strictEqual(img.get_height(), 30)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("resize PNG with contain fit on differing-AR image produces exact 4:3 result", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(80, 60, 0, 200, 100)
      const result = yield* svc.resize(png, "image/png", { width: 40, height: 40, fit: "contain" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 40)
      assert.strictEqual(img.get_height(), 30)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("resize PNG with fill fit to non-square produces exact dimensions", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(80, 60, 0, 200, 100)
      const result = yield* svc.resize(png, "image/png", { width: 50, height: 30, fit: "fill" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 50)
      assert.strictEqual(img.get_height(), 30)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )
})

describe("ThumbnailServicePhotonLive — cover crop (crop() API regression guard)", () => {
  it.scoped("cover crop on a wide image produces correctly centred result", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 255, 0, 0)
      const result = yield* svc.resize(png, "image/png", { width: 40, height: 40, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 40)
      assert.strictEqual(img.get_height(), 40)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("cover crop on a tall image produces correctly centred result", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(90, 160, 0, 255, 0)
      const result = yield* svc.resize(png, "image/png", { width: 40, height: 40, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 40)
      assert.strictEqual(img.get_height(), 40)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("cover crop does not panic on larger-than-target image", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(300, 200, 100, 100, 100)
      const result = yield* Effect.either(svc.resize(png, "image/png", { width: 50, height: 50, fit: "cover" }))
      if (Either.isLeft(result)) {
        assert.fail("expected Right, got Left: " + result.left._tag)
      }
      const img = PhotonImage.new_from_byteslice(result.right)
      assert.strictEqual(img.get_width(), 50)
      assert.strictEqual(img.get_height(), 50)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("cover crop with x0 > 0 offset produces correct dimensions", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 200, 100, 50)
      const result = yield* svc.resize(png, "image/png", { width: 60, height: 40, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 60)
      assert.strictEqual(img.get_height(), 40)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("cover crop with y0 > 0 offset produces correct dimensions", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(90, 160, 50, 100, 200)
      const result = yield* svc.resize(png, "image/png", { width: 40, height: 60, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 40)
      assert.strictEqual(img.get_height(), 60)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("cover crop centred horizontally — pixel near right edge is predominantly blue", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makeSplitPng(300, 100, 150, 255, 0, 0, 0, 0, 255)
      const result = yield* svc.resize(png, "image/png", { width: 40, height: 50, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      const pixels = img.get_raw_pixels()
      const getPixel = (x: number, y: number) => {
        const i = (y * img.get_width() + x) * 4
        return [pixels[i], pixels[i + 1], pixels[i + 2]]
      }
      const left = getPixel(0, 25)
      const right = getPixel(39, 25)
      assert.ok(left[0] > 200, "left edge should be predominantly red")
      assert.ok(left[1] < 30)
      assert.ok(left[2] < 30)
      assert.ok(right[0] < 30, "right edge should be predominantly blue")
      assert.ok(right[1] < 30)
      assert.ok(right[2] > 200)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("cover crop centred vertically — pixel from bottom of output is blue (centred), not red (top-cropped)", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makeRowSplitPng(100, 300, 150, 255, 0, 0, 0, 0, 255)
      const result = yield* svc.resize(png, "image/png", { width: 50, height: 40, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      const pixels = img.get_raw_pixels()
      const getPixel = (x: number, y: number) => {
        const i = (y * img.get_width() + x) * 4
        return [pixels[i], pixels[i + 1], pixels[i + 2]]
      }
      const px = getPixel(25, 39)
      assert.ok(px[2] > 200, "bottom output pixel should be blue (crop centred at y0=55 reaches blue band), not red=" + px[0])
      assert.ok(px[0] < 30)
      assert.ok(px[1] < 30)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )
})

describe("ThumbnailServicePhotonLive — zero-axis spec", () => {
  it.scoped("zero-width (0x200) cover produces non-squashed result", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 128, 128, 128)
      const result = yield* svc.resize(png, "image/png", { width: 0, height: 40, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_height(), 40)
      assert.strictEqual(img.get_width(), Math.round(40 * (160 / 90)))
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("zero-height (100x0) contain produces non-squashed result", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 128, 128, 128)
      const result = yield* svc.resize(png, "image/png", { width: 100, height: 0, fit: "contain" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 100)
      assert.strictEqual(img.get_height(), Math.round(100 * (90 / 160)))
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("fill+zero-width (0x40) produces imgWidth by spec.height", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 128, 128, 128)
      const result = yield* svc.resize(png, "image/png", { width: 0, height: 40, fit: "fill" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 160)
      assert.strictEqual(img.get_height(), 40)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("cover+zero-height (100x0) produces spec.width by proportional height", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 128, 128, 128)
      const result = yield* svc.resize(png, "image/png", { width: 100, height: 0, fit: "cover" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 100)
      assert.strictEqual(img.get_height(), Math.round(100 * (90 / 160)))
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("contain+zero-width (0x40) produces proportional width by spec.height", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 128, 128, 128)
      const result = yield* svc.resize(png, "image/png", { width: 0, height: 40, fit: "contain" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_height(), 40)
      assert.strictEqual(img.get_width(), Math.round(40 * (160 / 90)))
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("fill+zero-height (100x0) produces spec.width by srcHeight", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(160, 90, 128, 128, 128)
      const result = yield* svc.resize(png, "image/png", { width: 100, height: 0, fit: "fill" })
      const img = PhotonImage.new_from_byteslice(result)
      assert.strictEqual(img.get_width(), 100)
      assert.strictEqual(img.get_height(), 90)
      img.free()
    }).pipe(Effect.provide(PhotonLiveLayer))
  )
})

describe("ThumbnailServicePhotonLive — MIME encoding arms", () => {
  it.scoped("PNG input with image/png produces valid PNG output", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(20, 20, 0, 200, 100)
      const result = yield* svc.resize(png, "image/png", { width: 10, height: 10, fit: "fill" })
      const signature = result.slice(0, 8)
      assert.deepStrictEqual(signature, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("JPEG input with image/jpeg produces valid JPEG output", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const jpeg = makeJpeg(20, 20)
      const result = yield* svc.resize(jpeg, "image/jpeg", { width: 10, height: 10, fit: "fill" })
      assert.strictEqual(result[0], 0xFF)
      assert.strictEqual(result[1], 0xD8)
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("WebP input with image/webp produces valid WebP output", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const webp = makeWebp(20, 20)
      const result = yield* svc.resize(webp, "image/webp", { width: 10, height: 10, fit: "fill" })
      const str = new TextDecoder().decode(result.slice(0, 12))
      assert.ok(str.startsWith("RIFF") && str.endsWith("WEBP"))
    }).pipe(Effect.provide(PhotonLiveLayer))
  )

  it.scoped("explicit PNG arm: output is always PNG bytes", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const png = makePng(20, 20, 255, 0, 0)
      const result = yield* svc.resize(png, "image/png", { width: 10, height: 10, fit: "fill" })
      const signature = result.slice(0, 8)
      assert.deepStrictEqual(signature, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    }).pipe(Effect.provide(PhotonLiveLayer))
  )
})

describe("ThumbnailServicePhotonLive — error handling", () => {
  it.scoped("resize with garbage input fails with ThumbnailError", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const result = yield* Effect.either(
        svc.resize(new Uint8Array([0, 1, 2, 3]), "image/png", { width: 100, height: 100, fit: "fill" })
      )
      assert.ok(Either.isLeft(result))
      assert.strictEqual(result.left._tag, "ThumbnailError")
    }).pipe(Effect.provide(PhotonLiveLayer))
  )
})
