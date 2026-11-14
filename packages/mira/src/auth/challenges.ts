import { Effect } from "effect"

import { CryptoService } from "@/crypto/index.js"

import { ChallengeCryptoError } from "./errors.js"

export const OTP_LENGTH = 6
export const OTP_TTL_MS = 10 * 60 * 1000
export const VERIFY_EMAIL_TTL_MS = 15 * 60 * 1000
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000
export const MAX_ATTEMPTS = 5
export const RESEND_COOLDOWN_MS = 60 * 1000
export const LOGIN_OTP_RESEND_COOLDOWN_MS = 30 * 1000
export const USER_WINDOW_MS = 15 * 60 * 1000
export const MAX_PER_USER = 5
export const MAX_PER_IP = 20

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

const encode = (value: string) => new TextEncoder().encode(value)

const hmacSha256 = async (secret: string, message: string) => {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, encode(message)))
}

const sha256 = async (message: string) =>
  new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encode(message)))

/** Constant-time compare for fixed-length HMAC/base64 strings. */
export const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const generateOtp = (): Effect.Effect<string, never, CryptoService> =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService
    const bytes = yield* crypto.randomBytes(4)
    const value =
      ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)
    return String((value >>> 0) % 1_000_000).padStart(OTP_LENGTH, "0")
  })

export const generateResetToken = (): Effect.Effect<string, never, CryptoService> =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService
    return bytesToBase64Url(yield* crypto.randomBytes(32))
  })

export const generateChallengeId = (): Effect.Effect<string, never, CryptoService> =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService
    return bytesToBase64Url(yield* crypto.randomBytes(18))
  })

export const hashOtp = (secret: string, challengeId: string, code: string, purpose: string) =>
  Effect.tryPromise({
    try: async () => bytesToBase64Url(await hmacSha256(secret, `${challengeId}\u0000${purpose}\u0000${code}`)),
    catch: (error) => new ChallengeCryptoError({ message: `OTP hash failed: ${String(error)}` })
  })

export const hashResetToken = (token: string) =>
  Effect.tryPromise({
    try: async () => bytesToBase64Url(await sha256(token)),
    catch: (error) => new ChallengeCryptoError({ message: `Reset token hash failed: ${String(error)}` })
  })
