import { Data, Effect, Layer } from "effect"

import type * as PhotonModule from "./photon.js"
import type { PhotonThumbnailOptions } from "./photon.js"
import { ThumbnailService, type ThumbnailError, type ThumbSpec } from "./types.js"

/**
 * Raised when the optional Photon backend cannot be loaded. The layer path
 * turns this into a defect (the app cannot serve thumbnails without it); the
 * Bun fallback maps it back into `ThumbnailError`.
 */
export class ThumbnailBackendLoadError extends Data.TaggedError("ThumbnailBackendLoadError")<{
  readonly cause: unknown
}> {}

/**
 * The one dynamic import of the Photon backend in the server package.
 *
 * `photon.ts` pulls in `@cf-wasm/photon/node`, whose module init compiles the
 * WASM binary. Apps without file fields never need that cost, so the import
 * only happens when this effect is executed — that is, when a layer built from
 * `lazy.ts` is actually constructed, or when the Bun fallback needs Photon.
 *
 * `import()` is safe to call repeatedly: the ECMAScript module map caches the
 * module instance, so later calls resolve immediately.
 */
export const loadPhotonModule: Effect.Effect<typeof PhotonModule, ThumbnailBackendLoadError> =
  Effect.tryPromise({
    try: () => import("./photon.js"),
    catch: (cause) => new ThumbnailBackendLoadError({ cause })
  })

/**
 * Photon-backed thumbnail layer, with the backend loaded on first build.
 *
 * Same service as `ThumbnailServicePhotonLive` in `photon.ts`; the difference
 * is that importing this module does not load `@cf-wasm/photon`. The default
 * app builder uses this layer, so the WASM payload is only paid by apps that
 * actually declare a file field.
 */
export const ThumbnailServicePhotonLive: Layer.Layer<ThumbnailService> = Layer.unwrap(
  loadPhotonModule.pipe(
    Effect.map((photon) => photon.ThumbnailServicePhotonLive),
    Effect.orDie
  )
)

/** Photon-backed layer with a custom pixel budget, loaded on first build. */
export const makeThumbnailServicePhotonLive = (
  options: PhotonThumbnailOptions = {}
): Layer.Layer<ThumbnailService> =>
  Layer.unwrap(
    loadPhotonModule.pipe(
      Effect.map((photon) => photon.makeThumbnailServicePhotonLive(options)),
      Effect.orDie
    )
  )

/**
 * Photon resize factory whose backend is loaded when the returned function is
 * first executed, not when this module is imported.
 */
export const makeResizePhoton =
  (options: PhotonThumbnailOptions = {}) =>
  (input: Uint8Array, mimeType: string, spec: ThumbSpec): Effect.Effect<Uint8Array, ThumbnailError> =>
    loadPhotonModule.pipe(
      Effect.orDie,
      Effect.flatMap((photon) => photon.makeResizePhoton(options)(input, mimeType, spec))
    )

export type { PhotonThumbnailOptions }
