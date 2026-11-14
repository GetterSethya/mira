import { Data, Effect } from "effect"

export class CryptoHashError extends Data.TaggedError("CryptoHashError")<{
  readonly message: string
}> {}

const encode = (value: string) => new TextEncoder().encode(value)

/** Base64url without padding, usable in URLs, bucket keys, and challenge hashes. */
export const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const subtle = () => globalThis.crypto.subtle

/**
 * `Bun.CryptoHasher` is a synchronous native hasher. Using it avoids the
 * WebCrypto promise hop on hot paths such as rate-limit key derivation and the
 * per-request `pwf` credential binding. Node and edge runtimes keep the
 * WebCrypto path.
 */
type BunCryptoHasherInstance = {
  update(value: string | ArrayBufferView): BunCryptoHasherInstance
  digest(): Uint8Array
}

type BunCryptoHasherConstructor = new (
  algorithm: string,
  key?: string | ArrayBufferView
) => BunCryptoHasherInstance

const bunCryptoHasher = (): BunCryptoHasherConstructor | undefined =>
  (globalThis as { Bun?: { CryptoHasher?: BunCryptoHasherConstructor } }).Bun?.CryptoHasher

const nativeDigest = (key: string | undefined, value: string): Uint8Array => {
  const Hasher = bunCryptoHasher()
  if (Hasher === undefined) throw new Error("Bun.CryptoHasher is unavailable")
  const hasher = key === undefined ? new Hasher("sha256") : new Hasher("sha256", key)
  return new Uint8Array(hasher.update(value).digest())
}

const sha256Digest = (value: string): Effect.Effect<Uint8Array, CryptoHashError> => {
  if (bunCryptoHasher() !== undefined) {
    return Effect.try({
      try: () => nativeDigest(undefined, value),
      catch: (error) => new CryptoHashError({ message: `SHA-256 failed: ${String(error)}` })
    })
  }
  return Effect.tryPromise({
    try: async () => new Uint8Array(await subtle().digest("SHA-256", encode(value))),
    catch: (error) => new CryptoHashError({ message: `SHA-256 failed: ${String(error)}` })
  })
}

const hmacSha256Digest = (
  secret: string,
  value: string
): Effect.Effect<Uint8Array, CryptoHashError> => {
  if (bunCryptoHasher() !== undefined) {
    return Effect.try({
      try: () => nativeDigest(secret, value),
      catch: (error) => new CryptoHashError({ message: `HMAC-SHA-256 failed: ${String(error)}` })
    })
  }
  return Effect.tryPromise({
    try: async () => {
      const key = await subtle().importKey(
        "raw",
        encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      return new Uint8Array(await subtle().sign("HMAC", key, encode(value)))
    },
    catch: (error) => new CryptoHashError({ message: `HMAC-SHA-256 failed: ${String(error)}` })
  })
}

export const sha256Base64Url = (value: string): Effect.Effect<string, CryptoHashError> =>
  sha256Digest(value).pipe(Effect.map(bytesToBase64Url))

export const hmacSha256Base64Url = (
  secret: string,
  value: string
): Effect.Effect<string, CryptoHashError> =>
  hmacSha256Digest(secret, value).pipe(Effect.map(bytesToBase64Url))

/** Standard base64 (with padding) HMAC-SHA-256, used by the JWT `pwf` claim. */
export const hmacSha256Base64 = (
  secret: string,
  value: string
): Effect.Effect<string, CryptoHashError> =>
  hmacSha256Digest(secret, value).pipe(Effect.map(bytesToBase64))
