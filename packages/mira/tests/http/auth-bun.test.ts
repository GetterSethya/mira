import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { AuthService } from "@/http/auth.js"
import { BunAuthServiceLayer } from "@/http/auth-bun.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { hashScryptPassword } from "@/http/password-scrypt.js"

const hasBunPassword =
  typeof (globalThis as { Bun?: { password?: { hash?: unknown } } }).Bun?.password?.hash === "function"

const ARGON2ID_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaHZhbHVl"

describe("BunAuthServiceLayer", () => {
  it.effect("hashes with the expected algorithm for this runtime", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService
      const hash = yield* auth.hashPassword("correct horse battery staple")
      assert.ok(hasBunPassword ? hash.startsWith("$argon2id$") : hash.startsWith("scrypt$"))
      assert.strictEqual(yield* auth.verifyPassword("correct horse battery staple", hash), true)
      assert.strictEqual(yield* auth.verifyPassword("wrong password", hash), false)
    }).pipe(Effect.provide(BunAuthServiceLayer))
  )

  it.effect("verifies a legacy scrypt row", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService
      const legacy = yield* hashScryptPassword("legacy password")
      assert.strictEqual(yield* auth.verifyPassword("legacy password", legacy), true)
      assert.strictEqual(yield* auth.verifyPassword("wrong password", legacy), false)
    }).pipe(Effect.provide(BunAuthServiceLayer))
  )

  it.effect("rejects malformed and unknown password hashes", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService
      assert.strictEqual(yield* auth.verifyPassword("password", "not-a-hash"), false)
      assert.strictEqual(yield* auth.verifyPassword("password", "scrypt$onlysalt"), false)
    }).pipe(Effect.provide(BunAuthServiceLayer))
  )

  it.effect("requests a rehash for scrypt rows only when Bun.password exists", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService
      assert.strictEqual(auth.needsRehash?.("scrypt$salt$hash"), hasBunPassword)
      assert.strictEqual(auth.needsRehash?.(ARGON2ID_HASH), false)
    }).pipe(Effect.provide(BunAuthServiceLayer))
  )
})

describe("NodeAuthServiceLayer compatibility", () => {
  it.effect("fails closed on an Argon2id row instead of throwing", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService
      assert.strictEqual(yield* auth.verifyPassword("correct horse battery staple", ARGON2ID_HASH), false)
    }).pipe(Effect.provide(NodeAuthServiceLayer))
  )

  it.effect("never requests a rehash", () =>
    Effect.gen(function* () {
      const auth = yield* AuthService
      assert.strictEqual(auth.needsRehash?.("scrypt$salt$hash"), false)
      assert.strictEqual(auth.needsRehash?.(ARGON2ID_HASH), false)
    }).pipe(Effect.provide(NodeAuthServiceLayer))
  )
})
