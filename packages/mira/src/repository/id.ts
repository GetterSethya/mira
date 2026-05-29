import { Effect } from "effect"
import { CryptoService } from "@/crypto/index.js"

/** Generates a 15-character URL-safe alphanumeric ID. */
export const generateId = (): Effect.Effect<string, never, CryptoService> =>
  Effect.gen(function* () {
    const crypto = yield* CryptoService
    const buf = yield* crypto.randomBytes(12)
    return Buffer.from(buf).toString("base64url").slice(0, 15)
  })
