# thumbnail

## Overview

Image-resizing abstraction used by the file-serving route. `types.ts` declares
the `ThumbnailService` tag, the `ThumbSpec` shape, the `"WxH[tbf]"` spec parser,
the shared supported-MIME set, and a no-op layer for environments without an
image backend. `photon.ts` supplies the full implementation backed by
`@cf-wasm/photon`, computing target dimensions (including cover/contain fits and
zero-axis auto-scaling), cropping to the requested box, and encoding back to
JPEG/WebP/PNG. `bun.ts` adds a native `Bun.Image` implementation for `contain`
and `fill`; `cover` and native failures fall back to Photon. The package is
deliberately I/O-free: caching (`_thumbs/<filename>/<spec>`) and persistence are
handled by the HTTP layer and file storage, not here.

## Interface

### `types.ts`

- `ThumbSpec` (type) — `{ width, height, fit: "cover" | "contain" | "fill" }`; a `0` axis means auto-scale. [types.ts:ThumbSpec]
- `ThumbnailError` — `Data.TaggedError("ThumbnailError")` carrying a `reason` string. [types.ts:ThumbnailError]
- `ThumbnailService` — `Context.Service` with `supported(mimeType): boolean` and `resize(input, mimeType, spec): Effect<Uint8Array, ThumbnailError>`. [types.ts:ThumbnailService]
- `parseThumbSpec(raw)` — parses `"WxH"`, `"WxHt"`, `"WxHb"`, `"WxHf"`; returns `null` for unrecognised strings. [types.ts:parseThumbSpec]
- `SUPPORTED_THUMBNAIL_MIME_TYPES` — shared JPEG/PNG/WebP set. [types.ts:SUPPORTED_THUMBNAIL_MIME_TYPES]
- `DEFAULT_THUMBNAIL_MAX_PIXELS` — 64 MP default budget shared by both backends. [types.ts:DEFAULT_THUMBNAIL_MAX_PIXELS]
- `ThumbnailServiceNoopLive` — layer reporting `supported: false` and failing every resize with `ThumbnailError`. [types.ts:ThumbnailServiceNoopLive]

### `dimensions.ts`

- `readImageDimensions(input)` — header-only PNG/JPEG/WebP dimension parser; `null` for unrecognised or truncated input. [dimensions.ts:readImageDimensions]
- `assertImageWithinPixelBudget(input, maxPixels)` — rejects a header whose `width * height` exceeds the budget before any decoder allocates pixels. [dimensions.ts:assertImageWithinPixelBudget]

### `photon.ts`

- `makeResizePhoton(options)` — builds a Photon resize function that checks the header budget before decoding. [photon.ts:makeResizePhoton]
- `resizePhoton(input, mimeType, spec)` — the default Photon resize path (64 MP budget), including centre cropping for `cover`. [photon.ts:resizePhoton]
- `makeThumbnailServicePhotonLive(options)` — Photon layer with a configurable budget. [photon.ts:makeThumbnailServicePhotonLive]
- `ThumbnailServicePhotonLive` — default Photon layer backed by `@cf-wasm/photon/node`; supported MIME set is JPEG/PNG/WebP. [photon.ts:ThumbnailServicePhotonLive]
- `computeDimensions(imgWidth, imgHeight, spec)` — pure target-size calculation for fill/cover/contain and zero-axis specs. [photon.ts:computeDimensions]

### `bun.ts`

- `ThumbnailServiceBunLive` — layer that uses native `Bun.Image` for `contain`/`fill` and delegates `cover` or native failures to `resizePhoton`. [bun.ts:ThumbnailServiceBunLive]
- `makeThumbnailServiceBunLive(options)` — factory with `maxPixels` (default 64 MP) and `allowPhotonFallback` (default true); the strict mode proves the native path. [bun.ts:makeThumbnailServiceBunLive]
- `BunThumbnailOptions` — `{ maxPixels?, allowPhotonFallback? }`. [bun.ts:BunThumbnailOptions]

### `index.ts`

- Barrel re-exporting the Bun/Photon layers and factories, the header parser, `DEFAULT_THUMBNAIL_MAX_PIXELS`, `parseThumbSpec`, `SUPPORTED_THUMBNAIL_MIME_TYPES`, `ThumbnailError`, `ThumbnailService`, `ThumbnailServiceNoopLive`, and the relevant types. [index.ts:ThumbnailServiceBunLive]

No subdirectories.

## Invariants

- Spec strings must match `^(\d+)x(\d+)([tbf]?)$`; anything else yields `null` rather than throwing. [types.ts:parseThumbSpec]
- The trailing fit character maps `t` → `cover`, `b` → `contain`, `f` → `fill`, and no suffix defaults to `cover`. [types.ts:parseThumbSpec]
- `fill` returns the requested box, substituting each `0` axis with the source dimension. [photon.ts:computeDimensions]
- When both axes are `0` the source dimensions are returned unchanged. [photon.ts:computeDimensions]
- A single `0` axis preserves aspect ratio using the other axis, clamped to at least `1` pixel. [photon.ts:computeDimensions]
- `cover` scales by `max(targetW/imgW, targetH/imgH)` (rounded up); every other fit scales by the matching `min`. [photon.ts:computeDimensions]
- `supported` is true only for `SUPPORTED_THUMBNAIL_MIME_TYPES`; the no-op layer always reports `false`. [types.ts:SUPPORTED_THUMBNAIL_MIME_TYPES] [types.ts:ThumbnailServiceNoopLive]
- Photon images are released on every path via nested `Effect.acquireUseRelease` (`img.free()`, `scaled.free()`, and `cropped.free()` on the crop branch). [photon.ts:ThumbnailServicePhotonLive]
- `cover` crops from the centre (`Math.floor((actual - target) / 2)`) and only when the scaled image exceeds the requested box. [photon.ts:ThumbnailServicePhotonLive]
- A resize that comes back smaller than requested fails with `ThumbnailError` instead of returning an undersized image. [photon.ts:ThumbnailServicePhotonLive]
- Encoding is `get_bytes_jpeg(80)` for JPEG, `get_bytes_webp()` for WebP, and `get_bytes()` for PNG/anything else. [photon.ts:ThumbnailServicePhotonLive]
- Every Photon/encoding failure is caught and surfaced as `ThumbnailError({ reason: String(e) })`; no plain errors escape. [photon.ts:ThumbnailServicePhotonLive]
- The no-op layer's `resize` always fails and never touches the input bytes. [types.ts:ThumbnailServiceNoopLive]
- The Bun layer uses `Bun.Image` only for `contain` and `fill`; `Bun.Image` has no centre-crop primitive, so `cover` always uses Photon. [bun.ts:ThumbnailServiceBunLive]
- The Bun layer passes `computeDimensions` output to `Bun.Image.resize`, so contain dimensions stay aspect-correct and fill dimensions stay exact. [bun.ts:resizeWithBunImage]
- Every Bun image path parses the header through `Bun.Image.metadata()` with `maxPixels` (default 64 MP) before decoding, and the same guard runs before the Photon fallback. A metadata failure is not caught into Photon. [bun.ts:readBoundedImage]
- The layer independently checks `width * height <= maxPixels` after metadata; it does not rely solely on `Bun.Image` enforcing its own option. [bun.ts:readBoundedImage]
- Every Photon decode runs `assertImageWithinPixelBudget` first, so the Node path and the Bun `cover`/fallback path both enforce the same header budget. Supported Bun is `>=1.3.14`, which guarantees `Bun.Image`; the `BunPlatform` build check enforces that floor. [photon.ts:makeResizePhoton] [dimensions.ts:assertImageWithinPixelBudget]
- The header parser accepts only PNG (IHDR), JPEG (SOF), and WebP (VP8/VP8L/VP8X) headers; unknown or truncated input fails with `ThumbnailError` before decoding. [dimensions.ts:readImageDimensions]
- A native `Bun.Image` resize/encode error is caught and retried through Photon (unless `allowPhotonFallback` is false); the request only fails if both backends fail. [bun.ts:ThumbnailServiceBunLive]
- `allowPhotonFallback: false` makes `cover` and native failures fail instead of using Photon; the Bun smoke uses it to prove the native path. [bun.ts:makeThumbnailServiceBunLive]
- Bun.Image encodes JPEG at quality 80, WebP with defaults, and PNG with defaults, matching the Photon arms. [bun.ts:encode]

## Side Effects

- CPU-bound decode/resize/encode of image bytes in memory; `Bun.Image` terminals run off the JavaScript thread. No filesystem, network, timers, or environment access in this package. [photon.ts:ThumbnailServicePhotonLive] [bun.ts:resizeWithBunImage]
- Native WASM allocations from `@cf-wasm/photon` are explicitly freed (`free()`) to avoid leaks. [photon.ts:ThumbnailServicePhotonLive]
- Performs no caching or persistence of its own: `ThumbnailService.resize` only transforms bytes in memory, and the `_thumbs/…` cache is written elsewhere. [types.ts:ThumbnailService]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
