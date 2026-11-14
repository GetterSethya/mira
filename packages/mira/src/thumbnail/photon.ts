import { crop, PhotonImage, resize, SamplingFilter } from "@cf-wasm/photon/node"
import { Effect, Layer, Match } from "effect"

import { assertImageWithinPixelBudget } from "./dimensions.js"
import {
  DEFAULT_THUMBNAIL_MAX_PIXELS,
  SUPPORTED_THUMBNAIL_MIME_TYPES,
  ThumbnailError,
  ThumbnailService,
  type ThumbSpec
} from "./types.js"

export interface PhotonThumbnailOptions {
  /** Reject images whose `width * height` exceeds this before Photon decodes. */
  readonly maxPixels?: number
}

function computeDimensions(
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

const resizePhotonDecoded = (
  input: Uint8Array,
  mimeType: string,
  spec: ThumbSpec
): Effect.Effect<Uint8Array, ThumbnailError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => PhotonImage.new_from_byteslice(input),
      catch: (e) => new ThumbnailError({ reason: String(e) })
    }),
    (img) => {
      const w = img.get_width()
      const h = img.get_height()
      const dims = computeDimensions(w, h, spec)

      return Effect.acquireUseRelease(
        Effect.try({
          try: () => resize(img, dims.width, dims.height, SamplingFilter.Lanczos3),
          catch: (e) => new ThumbnailError({ reason: String(e) })
        }),
        (scaled) => {
          const encode = (src: PhotonImage) =>
            Effect.try({
              try: () =>
                Match.value(mimeType).pipe(
                  Match.when("image/jpeg", () => src.get_bytes_jpeg(80)),
                  Match.when("image/webp", () => src.get_bytes_webp()),
                  Match.when("image/png", () => src.get_bytes()),
                  Match.orElse(() => src.get_bytes())
                ),
              catch: (e) => new ThumbnailError({ reason: String(e) })
            })

          const actualW = scaled.get_width()
          const actualH = scaled.get_height()

          if (actualW < dims.width || actualH < dims.height) {
            return Effect.fail(new ThumbnailError({
              reason: `photon resize returned undersized image: requested ${dims.width}x${dims.height}, got ${actualW}x${actualH}`
            }))
          }

          const cw = spec.width === 0 ? actualW : Math.min(spec.width, actualW)
          const ch = spec.height === 0 ? actualH : Math.min(spec.height, actualH)

          if (spec.fit !== "cover" || (cw >= actualW && ch >= actualH)) {
            return encode(scaled)
          }

          return Effect.try({
            try: () => {
              const x0 = Math.floor((actualW - cw) / 2)
              const y0 = Math.floor((actualH - ch) / 2)
              return crop(scaled, x0, y0, x0 + cw, y0 + ch)
            },
            catch: (e) => new ThumbnailError({ reason: String(e) })
          }).pipe(
            Effect.flatMap((cropped) =>
              encode(cropped).pipe(
                Effect.ensuring(Effect.sync(() => cropped.free()))
              )
            )
          )
        },
        (scaled, _exit) => Effect.sync(() => scaled.free())
      )
    },
    (img, _exit) => Effect.sync(() => img.free())
  )

/**
 * Photon resize factory. The returned function parses the header and enforces
 * `maxPixels` before Photon allocates a pixel buffer.
 */
export const makeResizePhoton =
  (options: PhotonThumbnailOptions = {}) => {
    const maxPixels = options.maxPixels ?? DEFAULT_THUMBNAIL_MAX_PIXELS
    return (
      input: Uint8Array,
      mimeType: string,
      spec: ThumbSpec
    ): Effect.Effect<Uint8Array, ThumbnailError> =>
      assertImageWithinPixelBudget(input, maxPixels).pipe(
        Effect.flatMap(() => resizePhotonDecoded(input, mimeType, spec))
      )
  }

/** Default Photon resize with the 64 MP header budget. */
export const resizePhoton = makeResizePhoton()

/** Photon-backed layer with the default budget. */
export const makeThumbnailServicePhotonLive = (
  options: PhotonThumbnailOptions = {}
): Layer.Layer<ThumbnailService> =>
  Layer.succeed(
    ThumbnailService,
    ThumbnailService.of({
      supported: (mimeType) => SUPPORTED_THUMBNAIL_MIME_TYPES.has(mimeType),
      resize: makeResizePhoton(options)
    })
  )

export const ThumbnailServicePhotonLive: Layer.Layer<ThumbnailService> =
  makeThumbnailServicePhotonLive()

export { computeDimensions }
