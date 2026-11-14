import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { Effect, Option, Redacted } from "effect"
import type { HttpServerRequest } from "effect/http"
import type { SqlError } from "effect/sql"

import {
  AuthChallengeStore,
  generateChallengeId,
  generateOtp,
  generateResetToken,
  hashOtp,
  hashResetToken,
  MAX_ATTEMPTS,
  OTP_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  VERIFY_EMAIL_TTL_MS
} from "@/auth/index.js"
import type { ChallengePurpose, ChallengeRecord } from "@/auth/index.js"
import type { AuthEmailError } from "@/auth/index.js"
import {
  EmailFlowDisabledError,
  EmailUnavailableError,
  InvalidCodeError,
  InvalidResetTokenError,
  TooManyAttemptsError
} from "@/auth/index.js"
import { CollectionService } from "@/collection-service/collection-service.js"
import type { RequestCtx } from "@/collection-service/context.js"
import { AppConfig } from "@/config/index.js"
import { CryptoService } from "@/crypto/index.js"
import { Dialect } from "@/dialect/dialect.js"
import {
  EmailNotConfiguredError,
  EmailSendError,
  EmailService
} from "@/email/index.js"
import type {
  EmailMessage,
  EmailSendOptions,
  EmailServiceShape
} from "@/email/index.js"
import {
  loginAlertEmail,
  loginOtpEmail,
  passwordlessOtpEmail,
  passwordResetEmail,
  verificationOtpEmail
} from "@/email/index.js"
import {
  EmailRateLimitConfig,
  normalizeIpForRateLimit,
  RateLimitKeySecret,
  RateLimiter,
  RateLimitedError,
  rateLimitKey,
  RateLimitUnavailableError
} from "@/rate-limit/index.js"
import type { RateLimitRequest } from "@/rate-limit/index.js"
import type { AuthCollectionEmailOptions } from "@gettersethya/mira-client"
import { Repository } from "@/repository/repository.js"
import type { RepoRecord } from "@/repository/types.js"
import type { AuthError } from "./auth.js"
import { mintSession } from "./auth.js"
import { TokenStore } from "./token-store.js"

export type AuthEmailServices =
  | Repository
  | CollectionService
  | AppConfig
  | CryptoService
  | Dialect
  | RateLimiter
  | RateLimitKeySecret

type FlowError =
  | AuthEmailError
  | AuthError
  | SqlError.SqlError
  | EmailNotConfiguredError
  | EmailSendError

export const emailOptionsOf = (collection: AnyCollectionDef): Required<AuthCollectionEmailOptions> => {
  const email = collection.schema["x-auth"]?.email
  return {
    verification: email?.verification ?? false,
    loginAlerts: email?.loginAlerts ?? false,
    loginOtp: email?.loginOtp ?? "off",
    passwordless: email?.passwordless ?? false
  }
}

export const isAuthCollection = (collection: AnyCollectionDef) =>
  collection.schema["x-collection-kind"] === "auth"

export const clientIp = (req: HttpServerRequest.HttpServerRequest): string | null =>
  Option.getOrElse(req.remoteAddress, () => null)

export const userAgent = (req: HttpServerRequest.HttpServerRequest) =>
  req.headers["user-agent"] ?? "unknown"

const internalCtx = (): RequestCtx => ({ headers: {}, query: {}, internal: "auth-flow" })

const nowMs = () => Date.now()

const findAuthUser = (collection: AnyCollectionDef, email: string) =>
  Effect.gen(function* () {
    const repo = yield* Repository
    const rows = yield* repo.viewFilter(collection.name, {
      where: { sql: "t.email = ?", params: [email] }
    })
    return rows[0]
  })

const challengeTtl = (purpose: ChallengePurpose) => {
  switch (purpose) {
    case "password_reset":
      return PASSWORD_RESET_TTL_MS
    case "verify_email":
      return VERIFY_EMAIL_TTL_MS
    case "login_otp":
    case "passwordless":
      return OTP_TTL_MS
  }
}

const requireTransport = (): Effect.Effect<EmailServiceShape, EmailNotConfiguredError> =>
  Effect.gen(function* () {
    const email = yield* EmailService
    if (!email.enabled) {
      return yield* Effect.fail(
        new EmailNotConfiguredError({
          message: "Email transport is not configured. Add .email(SmtpEmail(...)) to the Mira builder."
        })
      )
    }
    return email
  })

const consumeEmailRequestLimits = (
  emailAddress: string,
  ip: string | null,
  purpose: ChallengePurpose
) =>
  Effect.gen(function* () {
    const secret = Redacted.value(yield* RateLimitKeySecret)
    const policies = yield* EmailRateLimitConfig

    const emailKey = yield* rateLimitKey(secret, `${purpose}:${emailAddress.trim()}`).pipe(
      Effect.catchTag("RateLimitUnavailableError", (error) =>
        Effect.logWarning("rate_limit.degraded", {
          reason: error.message,
          purpose
        }).pipe(Effect.as(null))
      )
    )
    if (emailKey === null) return yield* Effect.void

    const requests: Array<RateLimitRequest> = [
      {
        policy:
          purpose === "login_otp" ? policies.requestLoginCooldown : policies.requestCooldown,
        key: emailKey,
        cost: 1
      }
    ]

    const normalizedIp = normalizeIpForRateLimit(ip)
    if (normalizedIp !== null) {
      const ipKey = yield* rateLimitKey(secret, `ip:${normalizedIp}`).pipe(
        Effect.catchTag("RateLimitUnavailableError", (error) =>
          Effect.logWarning("rate_limit.degraded", {
            reason: error.message,
            purpose
          }).pipe(Effect.as(null))
        )
      )
      if (ipKey !== null) {
        requests.push({
          policy: purpose === "login_otp" ? policies.requestLoginIp : policies.requestRecoveryIp,
          key: ipKey,
          cost: 1
        })
      }
    } else {
      yield* Effect.logWarning("rate_limit.ip_unavailable", { purpose })
    }

    requests.push({ policy: policies.requestRecipient, key: emailKey, cost: 1 })

    const limiter = yield* RateLimiter
    const result = yield* limiter.consumeMany(requests).pipe(
      Effect.catchTag("RateLimitUnavailableError", (error) =>
        Effect.logWarning("rate_limit.degraded", {
          reason: error.message,
          purpose
        }).pipe(Effect.as({ decisions: [], blocked: null }))
      )
    )

    if (result.blocked !== null) {
      return yield* Effect.fail(
        new RateLimitedError({
          retryAfterSeconds: result.blocked.retryAfterSeconds,
          policy: result.blocked.policy,
          scope: result.blocked.policy.includes("cooldown") ? "cooldown" : "request"
        })
      )
    }
  })

const buildChallenge = (
  collection: AnyCollectionDef,
  userId: string,
  purpose: ChallengePurpose
) =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const secret = Redacted.value(config.jwtSecret)
    const id = yield* generateChallengeId()
    const raw = purpose === "password_reset" ? yield* generateResetToken() : yield* generateOtp()
    const tokenHash =
      purpose === "password_reset"
        ? yield* hashResetToken(raw)
        : yield* hashOtp(secret, id, raw, purpose)
    const createdAt = nowMs()
    const record: ChallengeRecord = {
      id,
      collection: collection.name,
      userId,
      purpose,
      tokenHash,
      expiresAt: createdAt + challengeTtl(purpose),
      consumedAt: null,
      attempts: 0,
      createdAt
    }
    return { record, secret: raw }
  })

const storeChallenge = (record: ChallengeRecord) =>
  Effect.gen(function* () {
    const store = yield* AuthChallengeStore
    const now = nowMs()
    yield* store.deleteExpired(now)
    yield* store.supersedeLive(record.collection, record.userId, record.purpose, now)
    yield* store.create(record)
  })

const sendEmail = (message: EmailMessage, options: EmailSendOptions) =>
  Effect.gen(function* () {
    const email = yield* requireTransport()
    yield* email.send(message, options).pipe(
      Effect.catchTag("EmailSendError", (error) =>
        Effect.fail(new EmailUnavailableError({ message: `Could not send email: ${error.code}` }))
      )
    )
  })

const detachSend = (message: EmailMessage, options: EmailSendOptions) =>
  Effect.gen(function* () {
    const email = yield* EmailService
    if (!email.enabled) return
    yield* Effect.forkDetach(
      email.send(message, options).pipe(
        Effect.catchTags({
          RateLimitedError: (error) =>
            Effect.logWarning("email.rate_limited", {
              purpose: options.purpose,
              collection: options.collection,
              policy: error.policy
            }),
          RateLimitUnavailableError: () =>
            Effect.logWarning("email.rate_limit_unavailable", {
              purpose: options.purpose,
              collection: options.collection
            }),
          EmailNotConfiguredError: () => Effect.void,
          EmailSendError: (error) =>
            Effect.logWarning("email.detached_send_failed", {
              purpose: options.purpose,
              code: error.code,
              command: error.command,
              responseCode: error.responseCode
            })
        })
      )
    )
  })

const appName = Effect.map(AppConfig, (config) => config.appName)

export const requestPasswordReset = (
  collection: AnyCollectionDef,
  emailAddress: string,
  ip: string | null
): Effect.Effect<{ readonly challengeId: string }, FlowError, AuthEmailServices> =>
  Effect.gen(function* () {
    const email = yield* requireTransport()
    if (email.describe().passwordResetUrl === null) {
      return yield* Effect.fail(
        new EmailNotConfiguredError({
          message: "Email is enabled but no passwordResetUrl is configured"
        })
      )
    }

    yield* consumeEmailRequestLimits(emailAddress, ip, "password_reset")

    const user = yield* findAuthUser(collection, emailAddress)
    if (user === undefined) {
      return { challengeId: yield* generateChallengeId() }
    }
    const userId = String(user["id"])
    const built = yield* buildChallenge(collection, userId, "password_reset")
    yield* storeChallenge(built.record)

    const description = email.describe()
    if (description.passwordResetUrl === null) {
      return { challengeId: built.record.id }
    }
    const resetUrl = description.passwordResetUrl
      .replaceAll("{{token}}", encodeURIComponent(built.secret))
      .replaceAll("{{collection}}", encodeURIComponent(collection.name))
    const message = passwordResetEmail({
      appName: yield* appName,
      email: emailAddress,
      resetUrl,
      expiresMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60_000)
    })
    yield* detachSend(message, {
      purpose: "password_reset",
      collection: collection.name,
      userId
    })
    return { challengeId: built.record.id }
  })

export const resetPassword = (
  collection: AnyCollectionDef,
  token: string,
  password: string
): Effect.Effect<{ readonly ok: true }, FlowError, AuthEmailServices> =>
  Effect.gen(function* () {
    const store = yield* AuthChallengeStore
    const tokenHash = yield* hashResetToken(token)
    const record = yield* store.findByTokenHash(collection.name, "password_reset", tokenHash)
    if (record === undefined) {
      return yield* Effect.fail(new InvalidResetTokenError({ message: "Invalid or expired reset token" }))
    }
    const consumed = yield* store.consumeToken(collection.name, "password_reset", tokenHash, nowMs())
    if (!consumed) {
      return yield* Effect.fail(new InvalidResetTokenError({ message: "Invalid or expired reset token" }))
    }
    const svc = yield* CollectionService
    yield* svc.update(
      collection,
      record.userId,
      { password, passwordConfirm: password },
      internalCtx()
    ).pipe(
      Effect.mapError((error) =>
        new EmailUnavailableError({ message: `Password reset failed: ${error._tag}` })
      )
    )
    const tokens = yield* TokenStore
    yield* tokens.bumpGeneration(collection.name, record.userId)
    yield* store.consumeAllForUser(collection.name, record.userId, nowMs())
    return { ok: true as const }
  })

export const requestEmailVerification = (
  collection: AnyCollectionDef,
  emailAddress: string,
  ip: string | null
): Effect.Effect<
  { readonly challengeId: string; readonly expiresAt: string },
  FlowError,
  AuthEmailServices
> =>
  Effect.gen(function* () {
    const options = emailOptionsOf(collection)
    if (!options.verification) {
      return yield* Effect.fail(new EmailFlowDisabledError({ collection: collection.name }))
    }
    yield* requireTransport()
    yield* consumeEmailRequestLimits(emailAddress, ip, "verify_email")

    const user = yield* findAuthUser(collection, emailAddress)
    if (user === undefined) {
      const expiresAt = nowMs() + VERIFY_EMAIL_TTL_MS
      return {
        challengeId: yield* generateChallengeId(),
        expiresAt: new Date(expiresAt).toISOString()
      }
    }
    const userId = String(user["id"])
    const built = yield* buildChallenge(collection, userId, "verify_email")
    yield* storeChallenge(built.record)
    const message = verificationOtpEmail({
      appName: yield* appName,
      email: emailAddress,
      code: built.secret,
      expiresMinutes: Math.round(VERIFY_EMAIL_TTL_MS / 60_000)
    })
    yield* detachSend(message, { purpose: "verify_email", collection: collection.name, userId })
    return {
      challengeId: built.record.id,
      expiresAt: new Date(built.record.expiresAt).toISOString()
    }
  })

export const verifyEmail = (
  collection: AnyCollectionDef,
  challengeId: string,
  code: string
): Effect.Effect<{ readonly verified: true }, FlowError, AuthEmailServices> =>
  Effect.gen(function* () {
    const store = yield* AuthChallengeStore
    const record = yield* store.findById(collection.name, challengeId, "verify_email")
    if (record === undefined) {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired code" }))
    }
    const config = yield* AppConfig
    const expected = yield* hashOtp(
      Redacted.value(config.jwtSecret),
      record.id,
      code,
      "verify_email"
    )
    if (expected !== record.tokenHash) {
      const attempted = yield* store.attemptAndConsume(record.id, MAX_ATTEMPTS, nowMs())
      if (attempted === null) {
        return yield* Effect.fail(new TooManyAttemptsError({ retryAfterSeconds: 60 }))
      }
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired code" }))
    }
    const consumed = yield* store.consumeById(record.id, nowMs())
    if (!consumed) {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired code" }))
    }
    const svc = yield* CollectionService
    yield* svc.update(
      collection,
      record.userId,
      { emailVerified: true },
      internalCtx()
    ).pipe(
      Effect.mapError((error) =>
        new EmailUnavailableError({ message: `Email verification failed: ${error._tag}` })
      )
    )
    return { verified: true as const }
  })

export const requestPasswordlessLogin = (
  collection: AnyCollectionDef,
  emailAddress: string,
  ip: string | null
): Effect.Effect<
  { readonly challengeId: string; readonly expiresAt: string },
  FlowError,
  AuthEmailServices
> =>
  Effect.gen(function* () {
    const options = emailOptionsOf(collection)
    if (!options.passwordless) {
      return yield* Effect.fail(new EmailFlowDisabledError({ collection: collection.name }))
    }
    yield* requireTransport()
    yield* consumeEmailRequestLimits(emailAddress, ip, "passwordless")

    const user = yield* findAuthUser(collection, emailAddress)
    if (user === undefined) {
      const expiresAt = nowMs() + OTP_TTL_MS
      return {
        challengeId: yield* generateChallengeId(),
        expiresAt: new Date(expiresAt).toISOString()
      }
    }
    const userId = String(user["id"])
    const built = yield* buildChallenge(collection, userId, "passwordless")
    yield* storeChallenge(built.record)
    const message = passwordlessOtpEmail({
      appName: yield* appName,
      email: emailAddress,
      code: built.secret,
      expiresMinutes: Math.round(OTP_TTL_MS / 60_000)
    })
    yield* detachSend(message, { purpose: "passwordless_otp", collection: collection.name, userId })
    return {
      challengeId: built.record.id,
      expiresAt: new Date(built.record.expiresAt).toISOString()
    }
  })

const verifyOtpChallenge = (
  collection: AnyCollectionDef,
  challengeId: string,
  code: string,
  purpose: "login_otp" | "passwordless"
) =>
  Effect.gen(function* () {
    const store = yield* AuthChallengeStore
    const record = yield* store.findById(collection.name, challengeId, purpose)
    if (record === undefined) {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired code" }))
    }
    const config = yield* AppConfig
    const expected = yield* hashOtp(Redacted.value(config.jwtSecret), record.id, code, purpose)
    if (expected !== record.tokenHash) {
      const attempted = yield* store.attemptAndConsume(record.id, MAX_ATTEMPTS, nowMs())
      if (attempted === null) {
        return yield* Effect.fail(new TooManyAttemptsError({ retryAfterSeconds: 60 }))
      }
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired code" }))
    }
    const consumed = yield* store.consumeById(record.id, nowMs())
    if (!consumed) {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired code" }))
    }
    const repo = yield* Repository
    const rows = yield* repo.view(collection.name, record.userId)
    if (Option.isNone(rows)) {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired code" }))
    }
    return yield* mintSession(collection, rows.value)
  })

export const loginWithPasswordless = (
  collection: AnyCollectionDef,
  challengeId: string,
  code: string
): Effect.Effect<
  { readonly token: string; readonly record: RepoRecord; readonly raw: RepoRecord },
  FlowError,
  AuthEmailServices
> => verifyOtpChallenge(collection, challengeId, code, "passwordless")

export const verifyLoginOtp = (
  collection: AnyCollectionDef,
  challengeId: string,
  code: string
): Effect.Effect<
  { readonly token: string; readonly record: RepoRecord; readonly raw: RepoRecord },
  FlowError,
  AuthEmailServices
> =>
  verifyOtpChallenge(collection, challengeId, code, "login_otp")

export const issueLoginOtp = (
  collection: AnyCollectionDef,
  user: RepoRecord,
  ip: string | null,
  emailAddress: string
): Effect.Effect<ChallengeRecord, FlowError, AuthEmailServices> =>
  Effect.gen(function* () {
    yield* requireTransport()
    const userId = String(user["id"])
    yield* consumeEmailRequestLimits(emailAddress, ip, "login_otp")
    const built = yield* buildChallenge(collection, userId, "login_otp")
    const message = loginOtpEmail({
      appName: yield* appName,
      email: emailAddress,
      code: built.secret,
      expiresMinutes: Math.round(OTP_TTL_MS / 60_000)
    })
    yield* sendEmail(message, { purpose: "login_otp", collection: collection.name, userId })
    yield* storeChallenge(built.record)
    return built.record
  })

export const resendLoginOtp = (
  collection: AnyCollectionDef,
  challengeId: string,
  ip: string | null
): Effect.Effect<ChallengeRecord, FlowError, AuthEmailServices> =>
  Effect.gen(function* () {
    const store = yield* AuthChallengeStore
    const existing = yield* store.findById(collection.name, challengeId, "login_otp")
    if (existing === undefined) {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired challenge" }))
    }
    const repo = yield* Repository
    const rows = yield* repo.view(collection.name, existing.userId)
    if (Option.isNone(rows)) {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired challenge" }))
    }
    const emailAddress = rows.value["email"]
    if (typeof emailAddress !== "string") {
      return yield* Effect.fail(new InvalidCodeError({ message: "Invalid or expired challenge" }))
    }
    return yield* issueLoginOtp(collection, rows.value, ip, emailAddress)
  })

export const sendLoginAlert = (
  collection: AnyCollectionDef,
  record: RepoRecord,
  req: HttpServerRequest.HttpServerRequest
): Effect.Effect<void, never, AuthEmailServices> =>
  Effect.gen(function* () {
    const options = emailOptionsOf(collection)
    if (!options.loginAlerts) return
    const email = yield* EmailService
    if (!email.enabled) return
    const emailAddress = record["email"]
    if (typeof emailAddress !== "string") return
    const name = yield* appName
    const message = loginAlertEmail({
      appName: name,
      collection: collection.name,
      email: emailAddress,
      ip: clientIp(req) ?? "unknown",
      userAgent: userAgent(req),
      time: new Date().toISOString()
    })
    yield* Effect.forkDetach(
      email.send(message, {
        purpose: "login_alert",
        collection: collection.name,
        userId: String(record["id"])
      }).pipe(
        Effect.catchTags({
          RateLimitedError: () => Effect.void,
          RateLimitUnavailableError: () => Effect.void,
          EmailNotConfiguredError: () => Effect.void,
          EmailSendError: (error) =>
            Effect.logWarning("email.login_alert_failed", {
              code: error.code,
              command: error.command,
              responseCode: error.responseCode
            })
        })
      )
    )
  })
