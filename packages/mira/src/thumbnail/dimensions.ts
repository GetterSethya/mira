import { Effect } from "effect"

import { DEFAULT_THUMBNAIL_MAX_PIXELS, ThumbnailError, type ThumbSpec } from "./types.js"

export interface ImageDimensions {
  readonly width: number
  readonly height: number
  readonly format: "png" | "jpeg" | "webp"
}

/**
 * Pure target-size calculation shared by the Photon and `Bun.Image` backends.
 *
 * `fill` returns the requested box, substituting each `0` axis with the source
 * dimension. `cover` scales by `max(...)` and rounds up so the result can be
 * cropped back to the requested box; every other fit scales by `min(...)`.
 */
export function computeDimensions(
  imgWidth: number,
  imgHeight: number,
  spec: ThumbSpec
): { width: number; height: number } {
  if (spec.fit === "fill") {
    return {
      width: spec.width === 0 ? imgWidth : spec.width,
      height: spec.height === 0 ? imgHeight : spec.height
    }
  }

  let targetW = spec.width
  let targetH = spec.height

  if (targetW === 0 && targetH === 0) {
    return { width: imgWidth, height: imgHeight }
  }

  if (targetW === 0) {
    targetW = Math.max(1, Math.round(targetH * (imgWidth / imgHeight)))
    return { width: targetW, height: targetH }
  }

  if (targetH === 0) {
    targetH = Math.max(1, Math.round(targetW * (imgHeight / imgWidth)))
    return { width: targetW, height: targetH }
  }

  if (spec.fit === "cover") {
    const scale = Math.max(targetW / imgWidth, targetH / imgHeight)
    return { width: Math.ceil(imgWidth * scale), height: Math.ceil(imgHeight * scale) }
  }

  const scale = Math.min(targetW / imgWidth, targetH / imgHeight)
  return { width: Math.round(imgWidth * scale), height: Math.round(imgHeight * scale) }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

const matchesSignature = (bytes: Uint8Array, offset: number, signature: ReadonlyArray<number>) => {
  if (offset + signature.length > bytes.length) return false
  for (let index = 0; index < signature.length; index++) {
    if (bytes[offset + index] !== signature[index]) return false
  }
  return true
}

const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  let value = ""
  for (let index = 0; index < length; index++) {
    value += String.fromCharCode(bytes[offset + index] ?? 0)
  }
  return value
}

const readPng = (view: DataView, bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.length < 24) return null
  if (!matchesSignature(bytes, 0, PNG_SIGNATURE)) return null
  if (ascii(bytes, 12, 4) !== "IHDR") return null
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  return { width, height, format: "png" }
}

// SOF0-SOF15 except DHT (0xC4), JPG (0xC8) and DAC (0xCC).
const JPEG_SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

const readJpeg = (view: DataView, bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2

  while (offset + 1 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return null
    const marker = bytes[offset] ?? 0
    offset++

    // EOI or SOS before a frame header: no dimensions to read.
    if (marker === 0xd9 || marker === 0xda) return null
    // Standalone markers: SOI, TEM, RSTn.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue

    if (offset + 2 > bytes.length) return null
    const length = view.getUint16(offset, false)
    if (length < 2 || offset + length > bytes.length) return null

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return null
      const height = view.getUint16(offset + 3, false)
      const width = view.getUint16(offset + 5, false)
      return { width, height, format: "jpeg" }
    }

    offset += length
  }

  return null
}

const readWebp = (view: DataView, bytes: Uint8Array): ImageDimensions | null => {
  if (bytes.length < 20) return null
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null

  const chunk = ascii(bytes, 12, 4)
  if (chunk === "VP8X") {
    if (bytes.length < 30) return null
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
    return { width, height, format: "webp" }
  }

  if (chunk === "VP8 ") {
    if (bytes.length < 30) return null
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    const width = view.getUint16(26, true) & 0x3fff
    const height = view.getUint16(28, true) & 0x3fff
    return { width, height, format: "webp" }
  }

  if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null
    const bits = view.getUint32(21, true)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { width, height, format: "webp" }
  }

  return null
}

/**
 * Read PNG/JPEG/WebP dimensions from the header without decoding pixels.
 * Returns `null` for unrecognised or truncated input.
 */
export const readImageDimensions = (input: Uint8Array): ImageDimensions | null => {
  if (input.length < 12) return null
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  return readPng(view, input) ?? readJpeg(view, input) ?? readWebp(view, input)
}

/**
 * Enforce a pixel budget from the image header before any decoder allocates a
 * pixel buffer. This runs on the Photon path (Node and old Bun) and is the
 * backstop for the Bun.Image path.
 */
export const assertImageWithinPixelBudget = (
  input: Uint8Array,
  maxPixels: number = DEFAULT_THUMBNAIL_MAX_PIXELS
): Effect.Effect<ImageDimensions, ThumbnailError> =>
  Effect.try({
    try: () => {
      const dimensions = readImageDimensions(input)
      if (dimensions === null) {
        throw new Error("unrecognised or truncated PNG/JPEG/WebP header")
      }
      if (
        !Number.isFinite(dimensions.width) ||
        !Number.isFinite(dimensions.height) ||
        dimensions.width <= 0 ||
        dimensions.height <= 0
      ) {
        throw new Error(`invalid dimensions ${dimensions.width}x${dimensions.height}`)
      }
      const pixels = dimensions.width * dimensions.height
      if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
        throw new Error(
          `image is ${dimensions.width}x${dimensions.height} (${pixels} pixels), budget is ${maxPixels}`
        )
      }
      return dimensions
    },
    catch: (error) =>
      new ThumbnailError({ reason: `thumbnail header check failed: ${String(error)}` })
  })
