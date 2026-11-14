import { Effect, Layer } from "effect"

import { AuthService } from "./auth.js"
import { hashScryptPassword, verifyScryptPassword } from "./password-scrypt.js"

type BunPasswordApi = {
  hash(
    password: string,
    options?: {
      readonly algorithm?: "argon2id" | "bcrypt"
      readonly memoryCost?: number
      readonly timeCost?: number
    }
  ): Promise<string>
  verify(password: string, hash: string): Promise<boolean>
}

const bunPassword = (): BunPasswordApi | undefined =>
  (globalThis as { Bun?: { password?: BunPasswordApi } }).Bun?.password

const ARGON2_PREFIX = "$argon2"
const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"] as const

const isBunPasswordHash = (stored: string): boolean =>
  stored.startsWith(ARGON2_PREFIX) || BCRYPT_PREFIXES.some((prefix) => stored.startsWith(prefix))

/**
 * OWASP-recommended Argon2id parameters (19 MiB, 2 iterations). Bun runs the
 * hash off the JavaScript thread; the encoded hash carries its own parameters,
 * so future cost changes still verify.
 */
const ARGON2_OPTIONS = {
  algorithm: "argon2id",
  memoryCost: 19_456,
  timeCost: 2
} as const

/**
 * Bun-native `AuthService`.
 *
 * New passwords are hashed with `Bun.password` (Argon2id). Existing
 * `scrypt$<salt>$<hash>` rows keep working through the shared async scrypt
 * verifier, so a Node-created database can move to Bun without a migration.
 * If a runtime exposes the layer without `Bun.password`, hashing falls back to
 * scrypt rather than failing closed.
 */
export const BunAuthServiceLayer = Layer.succeed(
  AuthService,
  AuthService.of({
    hashPassword: (plain) =>
      Effect.gen(function* () {
        const password = bunPassword()
        if (password === undefined) return yield* hashScryptPassword(plain)
        return yield* Effect.tryPromise({
          try: () => password.hash(plain, ARGON2_OPTIONS),
          catch: (error) => new Error(`Bun.password.hash failed: ${String(error)}`)
        }).pipe(Effect.orDie)
      }),
    verifyPassword: (plain, stored) =>
      Effect.gen(function* () {
        if (stored.startsWith("scrypt$")) {
          return yield* verifyScryptPassword(plain, stored)
        }
        const password = bunPassword()
        if (password === undefined || !isBunPasswordHash(stored)) return false
        return yield* Effect.tryPromise({
          try: () => password.verify(plain, stored),
          catch: () => new Error("Bun.password.verify failed")
        }).pipe(Effect.orElseSucceed(() => false))
      })
  })
)
