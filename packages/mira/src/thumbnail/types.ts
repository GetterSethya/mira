import { Context, Data, Effect, Layer } from "effect"

export type ThumbSpec = {
  width: number
  height: number
  fit: "cover" | "contain" | "fill"
}

export class ThumbnailError extends Data.TaggedError("ThumbnailError")<{
  reason: string
}> {}

export class ThumbnailService extends Context.Tag("ThumbnailService")<
  ThumbnailService,
  {
    supported(mimeType: string): boolean
    resize(
      input: Uint8Array,
      mimeType: string,
      spec: ThumbSpec
    ): Effect.Effect<Uint8Array, ThumbnailError>
  }
>() {}

// Format: "WxH", "WxHt" (cover), "WxHb" (contain), "WxHf" (fill)
// Either dimension may be 0 (auto-scale). Returns null for unrecognised strings.
export function parseThumbSpec(raw: string): ThumbSpec | null {
  const match = /^(\d+)x(\d+)([tbf]?)$/.exec(raw)
  if (match === null) return null
  const width = parseInt(match[1], 10)
  const height = parseInt(match[2], 10)
  const fitChar = match[3]
  const fit: "cover" | "contain" | "fill" =
    fitChar === "b" ? "contain" : fitChar === "f" ? "fill" : "cover"
  return { width, height, fit }
}

export const ThumbnailServiceNoopLive: Layer.Layer<ThumbnailService> = Layer.succeed(
  ThumbnailService,
  ThumbnailService.of({
    supported: () => false,
    resize: (_input, _mimeType, _spec) =>
      Effect.fail(new ThumbnailError({ reason: "noop: thumbnail generation not available" }))
  })
)
