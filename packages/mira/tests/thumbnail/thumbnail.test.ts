import { assert, describe, it } from "@effect/vitest"
import { Effect, Result } from "effect"

import { parseThumbSpec,ThumbnailService, ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

describe("parseThumbSpec", () => {
  it("parses WxH as cover", () =>
    assert.deepStrictEqual(parseThumbSpec("100x200"), { width: 100, height: 200, fit: "cover" })
  )

  it("parses WxHt as cover", () =>
    assert.deepStrictEqual(parseThumbSpec("300x400t"), { width: 300, height: 400, fit: "cover" })
  )

  it("parses WxHb as contain", () =>
    assert.deepStrictEqual(parseThumbSpec("300x400b"), { width: 300, height: 400, fit: "contain" })
  )

  it("parses WxHf as fill", () =>
    assert.deepStrictEqual(parseThumbSpec("300x400f"), { width: 300, height: 400, fit: "fill" })
  )

  it("parses 0x200 (auto-width)", () =>
    assert.deepStrictEqual(parseThumbSpec("0x200"), { width: 0, height: 200, fit: "cover" })
  )

  it("parses 100x0 (auto-height)", () =>
    assert.deepStrictEqual(parseThumbSpec("100x0"), { width: 100, height: 0, fit: "cover" })
  )

  it("returns null for garbage", () => {
    assert.strictEqual(parseThumbSpec("invalid"), null)
    assert.strictEqual(parseThumbSpec("100"), null)
    assert.strictEqual(parseThumbSpec("100x"), null)
    assert.strictEqual(parseThumbSpec(""), null)
    assert.strictEqual(parseThumbSpec("wxh"), null)
  })
})

describe("ThumbnailServiceNoopLive", () => {
  it.effect("supported always returns false", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      assert.strictEqual(svc.supported("image/jpeg"), false)
      assert.strictEqual(svc.supported("image/png"), false)
      assert.strictEqual(svc.supported("image/webp"), false)
    }).pipe(Effect.provide(ThumbnailServiceNoopLive))
  )

  it.effect("resize fails with ThumbnailError", () =>
    Effect.gen(function* () {
      const svc = yield* ThumbnailService
      const result = yield* svc
        .resize(new Uint8Array([1, 2, 3]), "image/jpeg", { width: 100, height: 100, fit: "cover" })
        .pipe(Effect.result)
      assert.ok(Result.isFailure(result))
      assert.strictEqual(result.failure._tag, "ThumbnailError")
    }).pipe(Effect.provide(ThumbnailServiceNoopLive))
  )
})
