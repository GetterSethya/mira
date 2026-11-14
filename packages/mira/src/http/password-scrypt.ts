import * as nodeCrypto from "node:crypto"

import { Effect } from "effect"

const SCRYPT_KEY_LENGTH = 64

/**
 * Async scrypt via `node:crypto`. Bun implements the same API natively, so this
 * module is safe to import from the Bun platform. It exists so both platform
 * auth layers share one legacy hash format (`scrypt$<salt>$<hash>`).
 */
export const scryptHash = (plain: string, salt: string): Effect.Effect<string> =>
  Effect.callback<Buffer, never>((resume) => {
    nodeCrypto.scrypt(plain, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) {
        resume(Effect.die(error))
      } else {
        resume(Effect.succeed(key))
      }
    })
  }).pipe(Effect.map((key) => key.toString("hex")))

export const hashScryptPassword = (plain: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const salt = nodeCrypto.randomBytes(16).toString("hex")
    const hash = yield* scryptHash(plain, salt)
    return `scrypt$${salt}$${hash}`
  })

export const verifyScryptPassword = (
  plain: string,
  stored: string
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const parts = stored.split("$")
    if (parts.length !== 3 || parts[0] !== "scrypt") return false
    const salt = parts[1]
    const expected = parts[2]
    if (salt === undefined || expected === undefined) return false
    const hash = yield* scryptHash(plain, salt)
    return hash === expected
  })
