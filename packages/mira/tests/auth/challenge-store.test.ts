import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vitest"

import {
  AuthChallengeStore,
  AuthChallengeStoreLive,
  inMemoryAuthChallengeStore
} from "@/auth/index.js"
import type { AuthChallengeStoreShape, ChallengeRecord } from "@/auth/index.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"

const record = (overrides: Partial<ChallengeRecord> = {}): ChallengeRecord => ({
  id: "challenge-1",
  collection: "users",
  userId: "user-1",
  purpose: "login_otp",
  tokenHash: "hash-1",
  expiresAt: Date.now() + 60_000,
  consumedAt: null,
  attempts: 0,
  createdAt: Date.now(),
  newEmail: null,
  ...overrides
})

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const dialectLayer = Layer.succeed(Dialect, sqliteDialect)
const storeLayer = AuthChallengeStoreLive.pipe(Layer.provide(Layer.mergeAll(sqliteLayer, dialectLayer)))

const exercise = (label: string) => (store: AuthChallengeStoreShape) =>
  Effect.gen(function* () {
    const now = Date.now()
    yield* store.create(record({ createdAt: now, expiresAt: now + 60_000 }))
    const found = yield* store.findByTokenHash("users", "login_otp", "hash-1")
    expect(found?.id, label).toBe("challenge-1")
    const first = yield* store.attemptAndConsume("challenge-1", 2, now)
    expect(first, label).toEqual({ attempts: 1, consumed: false })
    const second = yield* store.attemptAndConsume("challenge-1", 2, now)
    expect(second, label).toEqual({ attempts: 2, consumed: true })
    const afterConsume = yield* store.findByTokenHash("users", "login_otp", "hash-1")
    expect(afterConsume, label).toBeUndefined()

    yield* store.create(
      record({
        id: "expired",
        createdAt: now - 120_000,
        expiresAt: now - 60_000
      })
    )
    yield* store.deleteExpired(now)
    expect(yield* store.findById("users", "expired", "login_otp"), label).toBeUndefined()
  })

describe("AuthChallengeStore", () => {
  it.effect("in-memory default supports atomic attempts and expiry pruning", () =>
    exercise("memory")(inMemoryAuthChallengeStore)
  )

  it.effect("SQL implementation creates the tables and behaves the same", () =>
    Effect.gen(function* () {
      const store = yield* AuthChallengeStore
      yield* exercise("sql")(store)
    }).pipe(Effect.provide(storeLayer))
  )

  it.effect("rejects a second unconsumed challenge for the same tuple", () =>
    Effect.gen(function* () {
      const store = yield* AuthChallengeStore
      const now = Date.now()
      yield* store.create(record({ id: "first", createdAt: now, expiresAt: now + 60_000 }))
      const exit = yield* Effect.exit(
        store.create(record({ id: "second", createdAt: now, expiresAt: now + 60_000 }))
      )
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(storeLayer))
  )

  it.effect("stores the target address for change_email challenges", () =>
    Effect.gen(function* () {
      const store = yield* AuthChallengeStore
      const now = Date.now()
      yield* store.create(
        record({
          id: "change-email",
          purpose: "change_email",
          tokenHash: "change-hash",
          newEmail: "new@example.com",
          createdAt: now,
          expiresAt: now + 60_000
        })
      )
      const found = yield* store.findByTokenHash("users", "change_email", "change-hash")
      expect(found?.newEmail).toBe("new@example.com")
    }).pipe(Effect.provide(storeLayer))
  )
})
