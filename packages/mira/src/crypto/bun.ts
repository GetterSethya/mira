import { Effect, Layer } from "effect"

import { CryptoService } from "./crypto.js"

type BunRuntimeApi = {
  readonly randomUUIDv7?: () => string
}

const isUuid7Factory = (value: unknown): value is () => string => typeof value === "function"

const bunRuntime = (): BunRuntimeApi => {
  const bun: unknown = Reflect.get(globalThis, "Bun")
  if (typeof bun !== "object" || bun === null) return {}
  const randomUUIDv7: unknown = Reflect.get(bun, "randomUUIDv7")
  return isUuid7Factory(randomUUIDv7) ? { randomUUIDv7 } : {}
}

const randomBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

/**
 * Bun-native `CryptoService`.
 *
 * Random bytes come from the Web Crypto CSPRNG that Bun implements natively.
 * UUIDs use `Bun.randomUUIDv7()` when available, falling back to
 * `crypto.randomUUID()` (v4). UUIDv7 keeps generated file keys and other ids
 * sortable by creation time.
 */
export const BunCryptoLayer = Layer.succeed(
  CryptoService,
  CryptoService.of({
    randomBytesSync: randomBytes,
    randomBytes: (size) => Effect.sync(() => randomBytes(size)),
    randomUUID: () => Effect.sync(() => bunRuntime().randomUUIDv7?.() ?? crypto.randomUUID())
  })
)
