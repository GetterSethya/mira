import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { Headers } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { EmailService } from "@/email/types.js"
import type { EmailMessage, EmailServiceShape } from "@/email/types.js"
import { catchAuthEmailErrors } from "@/http/errors.js"
import { issueLoginOtp, requestPasswordReset } from "@/http/auth-email.js"
import {
  defaultEmailRateLimitPolicies,
  EmailRateLimitConfig,
  InMemoryRateLimiterLive,
  RateLimitKeySecret,
  RateLimitedError
} from "@/rate-limit/index.js"
import type { EmailRateLimitPolicies, RateLimitPolicy } from "@/rate-limit/index.js"
import { Repository, RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"

const sent: Array<EmailMessage> = []

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const repoWithSql = RepositoryLive.pipe(
  Layer.provide(sqliteLayer),
  Layer.provide(NodeCryptoLayer)
)

const FileStorageTest = Layer.succeed(
  FileStorage,
  FileStorage.of({
    upload: (key) => Effect.succeed(key),
    delete: () => Effect.void,
    url: (key) => `/files/${key}`,
    read: (key) => Effect.fail(new FileStorageNotFound({ key })),
    exists: () => Effect.succeed(false),
    list: () => Effect.succeed([])
  })
)

const DialectTest = Layer.succeed(Dialect, sqliteDialect)

const AppConfigTest = Layer.succeed(AppConfig, {
  appName: "Mira Test",
  port: 0,
  applicationUrl: "http://localhost",
  jwtSecret: Redacted.make("test-jwt-secret"),
  useS3: false,
  s3Config: Option.none(),
  logRetentionDays: 30
})

const fakeEmail: EmailServiceShape = {
  enabled: true,
  send: (message) => {
    sent.push(message)
    return Effect.succeed({ messageId: "m", accepted: ["user@example.com"], rejected: [] })
  },
  verify: () => Effect.void,
  describe: () => ({
    enabled: true,
    transport: "smtp",
    host: "localhost",
    port: 1025,
    secure: false,
    requireTLS: false,
    from: "mira@example.com",
    replyTo: null,
    hasAuth: false,
    passwordResetUrl: "http://localhost/reset?token={{token}}&collection={{collection}}"
  })
}

const low = (policy: RateLimitPolicy, limit: number): RateLimitPolicy => ({ ...policy, limit })

const withLimits = (overrides: Partial<EmailRateLimitPolicies>): EmailRateLimitPolicies => ({
  ...defaultEmailRateLimitPolicies,
  requestRecoveryIp: low(defaultEmailRateLimitPolicies.requestRecoveryIp, 10_000),
  requestLoginIp: low(defaultEmailRateLimitPolicies.requestLoginIp, 10_000),
  requestRecipient: low(defaultEmailRateLimitPolicies.requestRecipient, 10_000),
  requestCooldown: low(defaultEmailRateLimitPolicies.requestCooldown, 10_000),
  requestLoginCooldown: low(defaultEmailRateLimitPolicies.requestLoginCooldown, 10_000),
  ...overrides
})

const makeLayer = (policies: EmailRateLimitPolicies) => {
  const collectionService = makeCollectionServiceLayer([users as any]).pipe(
    Layer.provide(repoWithSql),
    Layer.provide(FileStorageTest),
    Layer.provide(sqliteLayer),
    Layer.provide(DialectTest),
    Layer.provide(NodeAuthServiceLayer)
  )
  return Layer.mergeAll(
    collectionService,
    repoWithSql,
    sqliteLayer,
    NodeCryptoLayer,
    AppConfigTest,
    DialectTest,
    Layer.succeed(EmailService, fakeEmail),
    InMemoryRateLimiterLive,
    Layer.succeed(RateLimitKeySecret, Redacted.make("test-rate-limit-secret")),
    Layer.succeed(EmailRateLimitConfig, policies)
  )
}

const users = {
  name: "users",
  fields: { email: { _tag: "FieldDef", kind: "email" } },
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      password: { type: "string" },
      emailVerified: { type: "boolean" },
      created: { type: "string" },
      updated: { type: "string" },
      seqId: { type: "number" }
    },
    required: [],
    "x-collection-kind": "auth"
  }
} as const

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      created TEXT,
      updated TEXT,
      seqId INTEGER
    )
  `)
  yield* sql`INSERT OR REPLACE INTO ${sql("users")} ${sql.insert({
    id: "user-1",
    email: "user@example.com",
    password: "hash",
    emailVerified: 0,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    seqId: 1
  })}`
})

const loadUser = Effect.gen(function* () {
  const repo = yield* Repository
  const rows = yield* repo.viewFilter("users", {
    where: { sql: "t.email = ?", params: ["user@example.com"] }
  })
  return rows[0]!
})

describe("auth email request rate limits", () => {
  it.effect("blocks a second request for the same recipient", () =>
    Effect.gen(function* () {
      const layer = makeLayer(
        withLimits({
          requestRecipient: low(defaultEmailRateLimitPolicies.requestRecipient, 1)
        })
      )
      yield* Effect.gen(function* () {
        yield* setup
        const first = yield* requestPasswordReset(users as any, "user@example.com", "1.2.3.4").pipe(
          Effect.exit
        )
        const second = yield* requestPasswordReset(users as any, "user@example.com", "1.2.3.4").pipe(
          Effect.exit
        )
        expect(first._tag).toBe("Success")
        expect(second._tag).toBe("Failure")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("uses an account-agnostic cooldown", () =>
    Effect.gen(function* () {
      const layer = makeLayer(
        withLimits({
          requestCooldown: low(defaultEmailRateLimitPolicies.requestCooldown, 1)
        })
      )
      yield* Effect.gen(function* () {
        yield* setup
        const known = yield* requestPasswordReset(users as any, "user@example.com", "1.2.3.4").pipe(
          Effect.exit
        )
        const knownAgain = yield* requestPasswordReset(
          users as any,
          "user@example.com",
          "1.2.3.4"
        ).pipe(Effect.exit)
        const unknown = yield* requestPasswordReset(
          users as any,
          "nobody@example.com",
          "1.2.3.4"
        ).pipe(Effect.exit)
        const unknownAgain = yield* requestPasswordReset(
          users as any,
          "nobody@example.com",
          "1.2.3.4"
        ).pipe(Effect.exit)
        expect(known._tag).toBe("Success")
        expect(knownAgain._tag).toBe("Failure")
        expect(unknown._tag).toBe("Success")
        expect(unknownAgain._tag).toBe("Failure")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("reset spam does not block login OTP for the same account", () =>
    Effect.gen(function* () {
      const layer = makeLayer(
        withLimits({
          requestRecipient: low(defaultEmailRateLimitPolicies.requestRecipient, 1)
        })
      )
      yield* Effect.gen(function* () {
        yield* setup
        yield* requestPasswordReset(users as any, "user@example.com", "1.2.3.4")
        const user = yield* loadUser
        const otp = yield* issueLoginOtp(users as any, user, "1.2.3.4", "user@example.com").pipe(
          Effect.exit
        )
        expect(otp._tag).toBe("Success")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("skips the IP policy when the peer address is unavailable", () =>
    Effect.gen(function* () {
      const layer = makeLayer(
        withLimits({
          requestRecoveryIp: low(defaultEmailRateLimitPolicies.requestRecoveryIp, 1)
        })
      )
      yield* Effect.gen(function* () {
        yield* setup
        const first = yield* requestPasswordReset(users as any, "user@example.com", null).pipe(
          Effect.exit
        )
        const second = yield* requestPasswordReset(users as any, "user@example.com", null).pipe(
          Effect.exit
        )
        expect(first._tag).toBe("Success")
        expect(second._tag).toBe("Success")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("maps a rate limit to 429 with Retry-After", () =>
    Effect.gen(function* () {
      const error = new RateLimitedError({
        retryAfterSeconds: 42,
        policy: "email:request:recipient",
        scope: "request"
      })
      const response = yield* catchAuthEmailErrors(Effect.fail(error)).pipe(Effect.flip)
      expect(response.status).toBe(429)
      const header = Headers.get(response.headers, "retry-after")
      expect(Option.getOrNull(header)).toBe("42")
    })
  )
})
