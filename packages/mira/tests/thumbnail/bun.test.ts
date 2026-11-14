import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { parseThumbSpec, ThumbnailService, ThumbnailServiceBunLive } from "@/thumbnail/index.js"

const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64"
  )
)

describe("ThumbnailServiceBunLive", () => {
  it.effect("reports the shared supported MIME types", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      assert.strictEqual(svc.supported("image/jpeg"), true)
      assert.strictEqual(svc.supported("image/png"), true)
      assert.strictEqual(svc.supported("image/webp"), true)
      assert.strictEqual(svc.supported("image/gif"), false)
    }).pipe(Effect.provide(ThumbnailServiceBunLive))
  )

  it.effect("resizes contain, fill, and cover specs", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      for (const raw of ["2x2b", "2x2f", "2x2"]) {
        const spec = parseThumbSpec(raw)
        assert.ok(spec !== null, `expected ${raw} to parse`)
        const resized = yield* svc.resize(png, "image/png", spec)
        assert.ok(resized.length > 0, `expected ${raw} to produce bytes`)
      }
    }).pipe(Effect.provide(ThumbnailServiceBunLive))
  )
})
