import { Effect, Layer } from "effect"

import { computeDimensions, resizePhoton } from "./photon.js"
import {
  DEFAULT_THUMBNAIL_MAX_PIXELS,
  SUPPORTED_THUMBNAIL_MIME_TYPES,
  ThumbnailError,
  ThumbnailService,
  type ThumbSpec
} from "./types.js"

/**
 * Minimal shape of the native `Bun.Image` pipeline. The runtime API is
 * documented at https://bun.com/docs/runtime/image; `@types/bun` does not ship
 * declarations yet, so the layer keeps its own structural type.
 */
type BunImagePipeline = {
  readonly width: number
  readonly height: number
  metadata(): Promise<{ readonly width: number; readonly height: number; readonly format: string }>
  resize(
    width: number,
    height: number,
    options?: {
      readonly fit?: "fill" | "inside"
      readonly filter?: string
      readonly withoutEnlargement?: boolean
    }
  ): BunImagePipeline
  png(options?: { readonly compressionLevel?: number }): BunImagePipeline
  jpeg(options?: { readonly quality?: number; readonly progressive?: boolean }): BunImagePipeline
  webp(options?: { readonly quality?: number; readonly lossless?: boolean }): BunImagePipeline
  bytes(): Promise<Uint8Array>
}

type BunImageConstructor = new (
  input: Uint8Array | ArrayBuffer | Blob | string,
  options?: { readonly maxPixels?: number; readonly autoOrient?: boolean }
) => BunImagePipeline

export interface BunThumbnailOptions {
  /**
   * Reject images whose `width * height` exceeds this before any pixel buffer
   * is allocated. Applies to both the native path and the Photon fallback.
   * Default: 64 megapixels.
   */
  readonly maxPixels?: number
  /**
   * When `false`, `cover` specs and native failures return an error instead of
   * falling back to Photon. Useful for proving the native path in smoke tests.
   * Default: `true`.
   */
  readonly allowPhotonFallback?: boolean
}

const bunImage = (): BunImageConstructor | undefined =>
  (globalThis as { Bun?: { Image?: BunImageConstructor } }).Bun?.Image

const encode = (image: BunImagePipeline, mimeType: string): BunImagePipeline => {
  if (mimeType === "image/jpeg") return image.jpeg({ quality: 80 })
  if (mimeType === "image/webp") return image.webp()
  return image.png()
}

type ImageInput = {
  readonly image: BunImagePipeline
  readonly width: number
  readonly height: number
}

/**
 * Parse the header and enforce the pixel budget. `Bun.Image` applies
 * `maxPixels` during `metadata()`, before allocating the decoded buffer, so a
 * compressed image bomb cannot reach either backend.
 */
const readBoundedImage = (
  Image: BunImageConstructor,
  input: Uint8Array,
  maxPixels: number
): Effect.Effect<ImageInput, ThumbnailError> =>
  Effect.tryPromise({
    try: async () => {
      const image = new Image(input, { maxPixels })
      const meta = await image.metadata()
      if (
        !Number.isFinite(meta.width) ||
        !Number.isFinite(meta.height) ||
        meta.width <= 0 ||
        meta.height <= 0
      ) {
        throw new Error(`invalid image dimensions: ${meta.width}x${meta.height}`)
      }
      // Defense in depth: do not rely solely on Bun.Image enforcing maxPixels.
      const pixels = meta.width * meta.height
      if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
        throw new Error(`image exceeds ${maxPixels} pixels (${meta.width}x${meta.height})`)
      }
      return { image, width: meta.width, height: meta.height }
    },
    catch: (error) =>
      new ThumbnailError({ reason: `Bun.Image metadata failed: ${String(error)}` })
  })

/**
 * Resize through `Bun.Image`, which decodes, resizes, and encodes off the
 * JavaScript thread using libjpeg-turbo/libwebp. Bun.Image has no centre-crop
 * primitive, so `cover` stays on Photon.
 */
const resizeWithBunImage = (
  input: ImageInput,
  mimeType: string,
  spec: ThumbSpec
): Effect.Effect<Uint8Array, ThumbnailError> =>
  Effect.tryPromise({
    try: async () => {
      const dims = computeDimensions(input.width, input.height, spec)
      const bytes = await encode(
        input.image.resize(dims.width, dims.height),
        mimeType
      ).bytes()
      if (bytes.length === 0) throw new Error("Bun.Image encoded zero bytes")
      return new Uint8Array(bytes)
    },
    catch: (error) => new ThumbnailError({ reason: `Bun.Image resize failed: ${String(error)}` })
  })

const makeLayer = (options: BunThumbnailOptions): Layer.Layer<ThumbnailService> => {
  const maxPixels = options.maxPixels ?? DEFAULT_THUMBNAIL_MAX_PIXELS
  const allowPhotonFallback = options.allowPhotonFallback ?? true
  return Layer.succeed(
    ThumbnailService,
    ThumbnailService.of({
      supported: (mimeType) => SUPPORTED_THUMBNAIL_MIME_TYPES.has(mimeType),
      resize: (input, mimeType, spec) => {
        const Image = bunImage()
        if (Image === undefined) return resizePhoton(input, mimeType, spec)
        return readBoundedImage(Image, input, maxPixels).pipe(
          Effect.flatMap((bounded) => {
            if (spec.fit === "cover") {
              return allowPhotonFallback
                ? resizePhoton(input, mimeType, spec)
                : Effect.fail(
                    new ThumbnailError({
                      reason: "Bun.Image cannot crop cover thumbnails"
                    })
                  )
            }
            return resizeWithBunImage(bounded, mimeType, spec).pipe(
              Effect.catchTag("ThumbnailError", (error) =>
                allowPhotonFallback ? resizePhoton(input, mimeType, spec) : Effect.fail(error)
              )
            )
          })
        )
      }
    })
  )
}

/**
 * Create a Bun thumbnail layer with a custom pixel budget or a strict
 * no-fallback mode. `ThumbnailServiceBunLive` is the default instance.
 */
export const makeThumbnailServiceBunLive = (
  options: BunThumbnailOptions = {}
): Layer.Layer<ThumbnailService> => makeLayer(options)

/**
 * Bun thumbnail layer.
 *
 * `contain` and `fill` specs use native `Bun.Image`. `cover` (the default spec)
 * and older Bun versions fall back to Photon; a native failure also falls back
 * rather than failing the request. The header is preflighted with a 64 MP
 * budget before either backend decodes pixels.
 */
export const ThumbnailServiceBunLive: Layer.Layer<ThumbnailService> =
  makeThumbnailServiceBunLive()
