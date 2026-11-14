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

const subtle = () => globalThis.crypto.subtle

export const sha256Base64Url = (value: string): Effect.Effect<string, CryptoHashError> =>
  Effect.tryPromise({
    try: async () =>
      bytesToBase64Url(new Uint8Array(await subtle().digest("SHA-256", encode(value)))),
    catch: (error) => new CryptoHashError({ message: `SHA-256 failed: ${String(error)}` })
  })

export const hmacSha256Base64Url = (
  secret: string,
  value: string
): Effect.Effect<string, CryptoHashError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await subtle().importKey(
        "raw",
        encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      const signature = await subtle().sign("HMAC", key, encode(value))
      return bytesToBase64Url(new Uint8Array(signature))
    },
    catch: (error) => new CryptoHashError({ message: `HMAC-SHA-256 failed: ${String(error)}` })
  })
