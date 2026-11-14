import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"

import { hmacSha256Base64, hmacSha256Base64Url, sha256Base64Url } from "@/crypto/hash.js"

describe("crypto hash helpers", () => {
  it.effect("sha256Base64Url matches the SHA-256 test vector", () =>
    Effect.gen(function* () {
      expect(yield* sha256Base64Url("hello")).toBe(
        "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"
      )
    })
  )

  it.effect("hmacSha256Base64Url matches the HMAC-SHA-256 test vector", () =>
    Effect.gen(function* () {
      expect(yield* hmacSha256Base64Url("secret", "hello")).toBe(
        "iKqz7ejTrflNJquQ07r9SiCDBww7zOnAFO4EpEOEfAs"
      )
    })
  )

  it.effect("hmacSha256Base64 returns padded base64 for the pwf claim", () =>
    Effect.gen(function* () {
      expect(yield* hmacSha256Base64("secret", "hello")).toBe(
        "iKqz7ejTrflNJquQ07r9SiCDBww7zOnAFO4EpEOEfAs="
      )
    })
  )
})
