# thumbnail

## Overview

Image-resizing abstraction used by the file-serving route. `types.ts` declares
the `ThumbnailService` tag, the `ThumbSpec` shape, the `"WxH[tbf]"` spec parser,
and a no-op layer for environments without an image backend. `photon.ts` supplies
the real implementation backed by `@cf-wasm/photon`, computing target dimensions
(including cover/contain fits and zero-axis auto-scaling), cropping to the
requested box, and encoding back to JPEG/WebP/PNG. The package is deliberately
I/O-free: caching (`_thumbs/<filename>/<spec>`) and persistence are handled by
the HTTP layer and file storage, not here.

## Interface

### `types.ts`

- `ThumbSpec` (type) — `{ width, height, fit: "cover" | "contain" | "fill" }`; a `0` axis means auto-scale. [types.ts:ThumbSpec]
- `ThumbnailError` — `Data.TaggedError("ThumbnailError")` carrying a `reason` string. [types.ts:ThumbnailError]
- `ThumbnailService` — `Context.Service` with `supported(mimeType): boolean` and `resize(input, mimeType, spec): Effect<Uint8Array, ThumbnailError>`. [types.ts:ThumbnailService]
- `parseThumbSpec(raw)` — parses `"WxH"`, `"WxHt"`, `"WxHb"`, `"WxHf"`; returns `null` for unrecognised strings. [types.ts:parseThumbSpec]
- `ThumbnailServiceNoopLive` — layer reporting `supported: false` and failing every resize with `ThumbnailError`. [types.ts:ThumbnailServiceNoopLive]

### `photon.ts`

- `ThumbnailServicePhotonLive` — layer backed by `@cf-wasm/photon/node`; supported MIME set is JPEG/PNG/WebP. [photon.ts:ThumbnailServicePhotonLive]
- `computeDimensions(imgWidth, imgHeight, spec)` — pure target-size calculation for fill/cover/contain and zero-axis specs. [photon.ts:computeDimensions]

### `index.ts`

- Barrel re-exporting `ThumbnailServicePhotonLive`, `parseThumbSpec`, `ThumbnailError`, `ThumbnailService`, `ThumbnailServiceNoopLive`, and the `ThumbSpec` type. `computeDimensions` is exported from `photon.ts` but not re-exported here. [index.ts:ThumbnailServicePhotonLive]

No subdirectories.

## Invariants

- Spec strings must match `^(\d+)x(\d+)([tbf]?)$`; anything else yields `null` rather than throwing. [types.ts:parseThumbSpec]
- The trailing fit character maps `t` → `cover`, `b` → `contain`, `f` → `fill`, and no suffix defaults to `cover`. [types.ts:parseThumbSpec]
- `fill` returns the requested box, substituting each `0` axis with the source dimension. [photon.ts:computeDimensions]
- When both axes are `0` the source dimensions are returned unchanged. [photon.ts:computeDimensions]
- A single `0` axis preserves aspect ratio using the other axis, clamped to at least `1` pixel. [photon.ts:computeDimensions]
- `cover` scales by `max(targetW/imgW, targetH/imgH)` (rounded up); every other fit scales by the matching `min`. [photon.ts:computeDimensions]
- `supported` is true only for the MIME types in `SUPPORTED`; the no-op layer always reports `false`. [photon.ts:SUPPORTED] [types.ts:ThumbnailServiceNoopLive]
- Photon images are released on every path via nested `Effect.acquireUseRelease` (`img.free()`, `scaled.free()`, and `cropped.free()` on the crop branch). [photon.ts:ThumbnailServicePhotonLive]
- `cover` crops from the centre (`Math.floor((actual - target) / 2)`) and only when the scaled image exceeds the requested box. [photon.ts:ThumbnailServicePhotonLive]
- A resize that comes back smaller than requested fails with `ThumbnailError` instead of returning an undersized image. [photon.ts:ThumbnailServicePhotonLive]
- Encoding is `get_bytes_jpeg(80)` for JPEG, `get_bytes_webp()` for WebP, and `get_bytes()` for PNG/anything else. [photon.ts:ThumbnailServicePhotonLive]
- Every Photon/encoding failure is caught and surfaced as `ThumbnailError({ reason: String(e) })`; no plain errors escape. [photon.ts:ThumbnailServicePhotonLive]
- The no-op layer's `resize` always fails and never touches the input bytes. [types.ts:ThumbnailServiceNoopLive]

## Side Effects

- CPU-bound decode/resize/encode of image bytes in memory; no filesystem, network, timers, or environment access in this package. [photon.ts:ThumbnailServicePhotonLive]
- Native WASM allocations from `@cf-wasm/photon` are explicitly freed (`free()`) to avoid leaks. [photon.ts:ThumbnailServicePhotonLive]
- Performs no caching or persistence of its own: `ThumbnailService.resize` only transforms bytes in memory, and the `_thumbs/…` cache is written elsewhere. [types.ts:ThumbnailService]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
