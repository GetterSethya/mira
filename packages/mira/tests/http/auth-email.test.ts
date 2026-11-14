import { NodeHttpServer } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, it } from "@effect/vitest"
import { AuthCollection, Field } from "@gettersethya/mira-client"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect } from "vitest"

import { applyRulesToCollections, defineRule } from "@/app/index.js"
import { makeCollectionServiceLayer } from "@/collection-service/collection-service.js"
import { AppConfig } from "@/config/index.js"
import { NodeCryptoLayer } from "@/crypto/node.js"
import { Dialect } from "@/dialect/dialect.js"
import { sqliteDialect } from "@/dialect/dialect-sqlite.js"
import { EmailService } from "@/email/index.js"
import type { EmailMessage, EmailServiceShape } from "@/email/index.js"
import { NodeAuthServiceLayer } from "@/http/auth-node.js"
import { makeCollectionRouter } from "@/http/router.js"
import { RepositoryLive } from "@/repository/repository.js"
import { FileStorage, FileStorageNotFound } from "@/storage/storage.js"
import { ThumbnailServiceNoopLive } from "@/thumbnail/index.js"

const UsersDef = AuthCollection.define(
  "users",
  { name: Field.text({ default: "" }) },
  {
    email: {
      verification: true,
      loginAlerts: true,
      loginOtp: "required",
      passwordless: true
    }
  }
)
const userRules = defineRule(UsersDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))
const Users = applyRulesToCollections([UsersDef], [userRules])[0]
const ALL_COLLECTIONS = [Users]

const AppConfigTest = Layer.succeed(
  AppConfig,
  AppConfig.of({
    appName: "test",
    port: 8080,
    applicationUrl: "http://localhost:8080",
    jwtSecret: Redacted.make("test-secret"),
    useS3: false,
    s3Config: Option.none(),
    logRetentionDays: 30
  })
)

let sent: Array<EmailMessage> = []
let nextMessageId = 1

const fakeEmail: EmailServiceShape = {
  enabled: true,
  send: (message) =>
    Effect.sync(() => {
      sent.push(message)
      return {
        messageId: `message-${nextMessageId++}`,
        accepted: [typeof message.to === "string" ? message.to : "multiple"],
        rejected: []
      }
    }),
  verify: () => Effect.void,
  describe: () => ({
    enabled: true,
    transport: "smtp",
    host: "localhost",
    port: 1025,
    secure: false,
    requireTLS: false,
    from: "no-reply@test.local",
    replyTo: null,
    hasAuth: false,
    passwordResetUrl: "http://localhost/reset?token={{token}}&collection={{collection}}"
  })
}

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

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" })
const DialectTest = Layer.succeed(Dialect, sqliteDialect)
const repoWithSql = RepositoryLive.pipe(Layer.provide(sqliteLayer), Layer.provide(NodeCryptoLayer))
const collectionServiceWithDeps = makeCollectionServiceLayer(ALL_COLLECTIONS).pipe(
  Layer.provide(repoWithSql),
  Layer.provide(FileStorageTest),
  Layer.provide(sqliteLayer),
  Layer.provide(DialectTest),
  Layer.provide(NodeAuthServiceLayer)
)

const testLayer = Layer.mergeAll(
  collectionServiceWithDeps,
  repoWithSql,
  FileStorageTest,
  sqliteLayer,
  ThumbnailServiceNoopLive,
  NodeHttpServer.layerTest,
  AppConfigTest,
  NodeCryptoLayer,
  NodeAuthServiceLayer,
  DialectTest,
  Layer.succeed(EmailService, fakeEmail)
)

const setupTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  sent = []
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "users" (
      "seqId" INTEGER PRIMARY KEY AUTOINCREMENT,
      "id" TEXT NOT NULL UNIQUE,
      "email" TEXT NOT NULL UNIQUE,
      "password" TEXT NOT NULL,
      "emailVerified" BOOLEAN NOT NULL DEFAULT 0,
      "name" TEXT NOT NULL DEFAULT '',
      "created" TEXT NOT NULL,
      "updated" TEXT NOT NULL
    )
  `)
  yield* sql.unsafe(`DELETE FROM "users"`)
})

const serve = Effect.flatMap(
  HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter(ALL_COLLECTIONS))),
  HttpServer.serveEffect()
)

const post = (path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body))
  )

const responseBody = <S extends Schema.Constraint>(schema: S) => (res: HttpClientResponse.HttpClientResponse) =>
  res.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

const ChallengeResponse = Schema.Struct({ challengeId: Schema.String })
const MessageResponse = Schema.Struct({ message: Schema.String })
const ErrorResponse = Schema.Struct({ error: Schema.String })
const TokenResponse = Schema.Struct({
  token: Schema.String,
  record: Schema.Record(Schema.String, Schema.Unknown)
})

const firstEmail = (): EmailMessage => {
  const message = sent[0]
  if (message === undefined) throw new Error("Expected an email to be sent")
  return message
}

const codeFrom = (message: EmailMessage) => {
  const match = message.text.match(/\b(\d{6})\b/)
  if (match === null) throw new Error(`No OTP in message: ${message.text}`)
  return match[1]
}

describe("auth email HTTP flows", () => {
  it.effect("returns auth-config and sends a verification OTP on registration", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve

      const configRes = yield* HttpClient.get("/api/collections/users/auth-config")
      const config = yield* responseBody(
        Schema.Struct({
          collection: Schema.String,
          emailConfigured: Schema.Boolean,
          email: Schema.Struct({
            verification: Schema.Boolean,
            loginAlerts: Schema.Boolean,
            loginOtp: Schema.String,
            passwordless: Schema.Boolean
          })
        })
      )(configRes)
      expect(config.emailConfigured).toBe(true)
      expect(config.email.verification).toBe(true)

      const createRes = yield* post("/api/collections/users", {
        email: "user@example.com",
        password: "password123",
        passwordConfirm: "password123",
        name: "User"
      })
      expect(createRes.status).toBe(201)
      const created = yield* responseBody(
        Schema.Struct({
          email: Schema.String,
          emailVerification: Schema.Struct({
            challengeId: Schema.String,
            expiresAt: Schema.String
          })
        })
      )(createRes)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.subject).toContain("Verify")
      const code = codeFrom(firstEmail())

      const verifyRes = yield* post("/api/collections/users/verify-email", {
        challengeId: created.emailVerification.challengeId,
        code
      })
      expect(verifyRes.status).toBe(200)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("runs password reset and invalidates the old password", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      yield* post("/api/collections/users", {
        email: "reset@example.com",
        password: "old-password",
        passwordConfirm: "old-password",
        name: "Reset"
      })
      sent = []

      const requestRes = yield* post("/api/collections/users/password-reset/request", {
        email: "reset@example.com"
      })
      expect(requestRes.status).toBe(202)
      expect(sent).toHaveLength(1)
      const resetUrl = sent[0]?.text.match(/https?:\/\/\S+/)?.[0] ?? ""
      const token = new URL(resetUrl).searchParams.get("token")
      expect(token).not.toBeNull()

      const resetRes = yield* post("/api/collections/users/password-reset", {
        token,
        password: "new-password",
        passwordConfirm: "new-password"
      })
      expect(resetRes.status).toBe(200)

      const oldLogin = yield* post("/api/collections/users/auth-with-password", {
        email: "reset@example.com",
        password: "old-password"
      })
      expect(oldLogin.status).toBe(403)

      const newLogin = yield* post("/api/collections/users/auth-with-password", {
        email: "reset@example.com",
        password: "new-password"
      })
      const newLoginBody = yield* responseBody(
        Schema.Struct({ otpRequired: Schema.Boolean, challengeId: Schema.String })
      )(newLogin)
      expect(newLoginBody.otpRequired).toBe(true)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("completes login OTP and passwordless OTP", () =>
    Effect.gen(function* () {
      yield* setupTables
      yield* serve
      yield* post("/api/collections/users", {
        email: "otp@example.com",
        password: "password123",
        passwordConfirm: "password123",
        name: "OTP"
      })
      sent = []

      const passwordRes = yield* post("/api/collections/users/auth-with-password", {
        email: "otp@example.com",
        password: "password123"
      })
      const challenge = yield* responseBody(ChallengeResponse)(passwordRes)
      expect(sent[0]?.subject).toContain("login code")
      const loginCode = codeFrom(firstEmail())
      const verifyRes = yield* post("/api/collections/users/auth-with-password/verify-otp", {
        challengeId: challenge.challengeId,
        code: loginCode
      })
      expect(verifyRes.status).toBe(200)
      const token = yield* responseBody(TokenResponse)(verifyRes)
      expect(token.token.length).toBeGreaterThan(0)

      sent = []
      const requestRes = yield* post("/api/collections/users/auth-with-otp/request", {
        email: "otp@example.com"
      })
      expect(requestRes.status).toBe(202)
      const passwordless = yield* responseBody(ChallengeResponse)(requestRes)
      const passwordlessCode = codeFrom(firstEmail())
      const passwordlessRes = yield* post("/api/collections/users/auth-with-otp", {
        challengeId: passwordless.challengeId,
        code: passwordlessCode
      })
      expect(passwordlessRes.status).toBe(200)
      const passwordlessToken = yield* responseBody(TokenResponse)(passwordlessRes)
      expect(passwordlessToken.token.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(testLayer))
  )
})
