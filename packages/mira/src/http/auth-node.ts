import * as nodeCrypto from "node:crypto"
import { Effect, Layer } from "effect"
import { AuthService } from "./auth.js"

function scryptHash(plain: string, salt: string) {
  return Effect.async<Buffer, never>((resume) => {
    nodeCrypto.scrypt(plain, salt, 64, (err, key) => {
      if (err) {
        resume(Effect.die(err))
      } else {
        resume(Effect.succeed(key))
      }
    })
  }).pipe(Effect.map((key) => key.toString("hex")))
}

export const NodeAuthServiceLayer = Layer.succeed(
  AuthService,
  AuthService.of({
    hashPassword: (plain) =>
      Effect.gen(function* () {
        const salt = nodeCrypto.randomBytes(16).toString("hex")
        const hash = yield* scryptHash(plain, salt)
        return `scrypt$${salt}$${hash}`
      }),
    verifyPassword: (plain, stored) =>
      Effect.gen(function* () {
        const parts = stored.split("$")
        if (parts.length !== 3 || parts[0] !== "scrypt") return false
        const salt = parts[1]
        const expected = parts[2]
        if (salt === undefined || expected === undefined) return false
        const hash = yield* scryptHash(plain, salt)
        return hash === expected
      })
  })
)
