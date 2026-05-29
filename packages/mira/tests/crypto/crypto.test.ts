import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect } from "effect"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { CryptoService } from "@/crypto/crypto.js"

const testLayer = NodeCryptoLayer

describe("CryptoService (NodeCryptoLayer)", () => {
  it.effect("randomBytesSync(16) returns Uint8Array of length 16 synchronously", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const buf = crypto.randomBytesSync(16)
      expect(buf).toBeInstanceOf(Uint8Array)
      expect(buf.length).toBe(16)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("randomBytesSync produces distinct values across calls", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const a = crypto.randomBytesSync(16)
      const b = crypto.randomBytesSync(16)
      expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"))
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("randomBytes(16) returns Uint8Array of length 16", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const buf = yield* crypto.randomBytes(16)
      expect(buf).toBeInstanceOf(Uint8Array)
      expect(buf.length).toBe(16)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("randomBytes(48) returns Uint8Array of length 48", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const buf = yield* crypto.randomBytes(48)
      expect(buf.length).toBe(48)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("randomBytes produces distinct values across calls", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const a = yield* crypto.randomBytes(16)
      const b = yield* crypto.randomBytes(16)
      expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"))
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("randomUUID() returns a UUID v4 string", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const uuid = yield* crypto.randomUUID()
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("randomUUID() produces distinct values across calls", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const a = yield* crypto.randomUUID()
      const b = yield* crypto.randomUUID()
      expect(a).not.toBe(b)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("randomBytesSync(8) hex-encodes to 16-char span IDs", () =>
    Effect.gen(function* () {
      const crypto = yield* CryptoService
      const buf = crypto.randomBytesSync(8)
      const hex = Buffer.from(buf).toString("hex")
      expect(hex.length).toBe(16)
      expect(hex).toMatch(/^[0-9a-f]+$/)
    }).pipe(Effect.provide(testLayer))
  )
})
