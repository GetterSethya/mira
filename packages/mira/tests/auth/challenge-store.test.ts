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

const record = (overrides: Partial<ChallengeRecord> = {}): ChallengeRecord => ({
  id: "challenge-1",
  collection: "users",
  userId: "user-1",
  purpose: "login_otp",
  tokenHash: "hash-1",
  expiresAt: Date.now() + 60_000,
  consumedAt: null,
  attempts: 0,
  requestIp: "127.0.0.1",
  createdAt: Date.now(),
  ...overrides
})

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const storeLayer = AuthChallengeStoreLive.pipe(Layer.provide(sqliteLayer))

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
    yield* store.logRequest("127.0.0.1", "login_otp", now)
    expect(yield* store.countRecentForIp("127.0.0.1", "login_otp", now - 1000), label).toBe(1)
    expect(yield* store.countRecentForUser("users", "user-1", "login_otp", now - 1000), label).toBe(1)
  })

describe("AuthChallengeStore", () => {
  it.effect("in-memory default supports atomic attempts and counters", () =>
    exercise("memory")(inMemoryAuthChallengeStore)
  )

  it.effect("SQL implementation creates the tables and behaves the same", () =>
    Effect.gen(function* () {
      const store = yield* AuthChallengeStore
      yield* exercise("sql")(store)
    }).pipe(Effect.provide(storeLayer))
  )
})
