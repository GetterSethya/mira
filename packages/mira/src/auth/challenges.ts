import { Effect } from "effect"

import { bytesToBase64Url, hmacSha256Base64Url, sha256Base64Url } from "@/crypto/hash.js"
import { CryptoService } from "@/crypto/index.js"

import { ChallengeCryptoError } from "./errors.js"

export const OTP_LENGTH = 6
export const OTP_TTL_MS = 10 * 60 * 1000
export const VERIFY_EMAIL_TTL_MS = 15 * 60 * 1000
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000
export const MAX_ATTEMPTS = 5

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
  hmacSha256Base64Url(secret, `${challengeId}\u0000${purpose}\u0000${code}`).pipe(
    Effect.mapError(
      (error) => new ChallengeCryptoError({ message: `OTP hash failed: ${error.message}` })
    )
  )

export const hashResetToken = (token: string) =>
  sha256Base64Url(token).pipe(
    Effect.mapError(
      (error) => new ChallengeCryptoError({ message: `Reset token hash failed: ${error.message}` })
    )
  )
