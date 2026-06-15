import { Effect } from "effect"
import { CryptoService } from "@/crypto/index.js"

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
// 248 = floor(256/62)*62 — threshold for unbiased modulo over 62 chars
const BIAS_THRESHOLD = 248

/** Generates a 15-character alphanumeric ID (a-z A-Z 0-9 only). */
export const generateId = (): Effect.Effect<string, never, CryptoService> =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService
    // 24 bytes gives ~23 usable bytes on average; far more than the 15 needed
    const buf = yield* crypto.randomBytes(24)
    let result = ""
    for (const byte of buf) {
      if (byte < BIAS_THRESHOLD) {
        result += ALPHABET[byte % 62]
        if (result.length === 15) break
      }
    }
    return result
  })
