import { describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { expect } from "vitest"

import { MiraPlugin } from "@/app/plugin.js"
import { makeHookedEmailServiceLayer } from "@/email/hooked.js"
import { EmailService } from "@/email/types.js"
import type { EmailServiceShape } from "@/email/types.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import {
  defaultEmailRateLimitPolicies,
  EmailRateLimitConfig,
  InMemoryRateLimiterLive,
  makeRateLimiter,
  RateLimitKeySecret,
  RateLimiter,
  RateLimitStoreError
} from "@/rate-limit/index.js"
import type { EmailRateLimitPolicies, RateLimitStoreShape } from "@/rate-limit/index.js"

const baseEmail = (onSend: () => void = () => {}): EmailServiceShape => ({
  enabled: true,
  send: () => {
    onSend()
    return Effect.succeed({ messageId: "m", accepted: ["a@example.com"], rejected: [] })
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
})

const withLimits = (overrides: Partial<EmailRateLimitPolicies>): EmailRateLimitPolicies => ({
  ...defaultEmailRateLimitPolicies,
  ...overrides
})

const makeLayer = (
  policies: EmailRateLimitPolicies,
  options: {
    readonly plugins?: ReadonlyArray<MiraPlugin<any>>
    readonly base?: EmailServiceShape
    readonly limiter?: ReturnType<typeof makeRateLimiter>
  } = {}
) =>
  makeHookedEmailServiceLayer().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(EmailService, options.base ?? baseEmail()),
        makeHookServiceLayer(options.plugins ?? []),
        options.limiter === undefined
          ? InMemoryRateLimiterLive
          : Layer.succeed(RateLimiter, options.limiter),
        Layer.succeed(RateLimitKeySecret, Redacted.make("test-rate-limit-secret")),
        Layer.succeed(EmailRateLimitConfig, policies)
      )
    )
  )

const send = (to: string, purpose = "password_reset") =>
  Effect.gen(function* () {
    const email = yield* EmailService
    return yield* email.send(
      { to, subject: "subject", text: "text" },
      { purpose, collection: "users" }
    )
  })

describe("email send rate limits", () => {
  it.effect("separates recovery and notification budgets", () =>
    Effect.gen(function* () {
      const layer = makeLayer(
        withLimits({
          sendRecoveryHourly: { ...defaultEmailRateLimitPolicies.sendRecoveryHourly, limit: 1 },
          sendNotificationHourly: {
            ...defaultEmailRateLimitPolicies.sendNotificationHourly,
            limit: 1
          }
        })
      )
      yield* Effect.gen(function* () {
        const security = yield* send("a@example.com").pipe(Effect.exit)
        const securityAgain = yield* send("b@example.com").pipe(Effect.exit)
        const notification = yield* send("c@example.com", "login_alert").pipe(Effect.exit)
        const notificationAgain = yield* send("d@example.com", "login_alert").pipe(Effect.exit)
        expect(security._tag).toBe("Success")
        expect(securityAgain._tag).toBe("Failure")
        expect(notification._tag).toBe("Success")
        expect(notificationAgain._tag).toBe("Failure")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("separates recovery and login budgets", () =>
    Effect.gen(function* () {
      const layer = makeLayer(
        withLimits({
          sendRecoveryHourly: { ...defaultEmailRateLimitPolicies.sendRecoveryHourly, limit: 1 },
          sendLoginHourly: { ...defaultEmailRateLimitPolicies.sendLoginHourly, limit: 1 }
        })
      )
      yield* Effect.gen(function* () {
        const recovery = yield* send("a@example.com", "password_reset").pipe(Effect.exit)
        const login = yield* send("b@example.com", "login_otp").pipe(Effect.exit)
        const recoveryAgain = yield* send("c@example.com", "password_reset").pipe(Effect.exit)
        const loginAgain = yield* send("d@example.com", "login_otp").pipe(Effect.exit)
        expect(recovery._tag).toBe("Success")
        expect(login._tag).toBe("Success")
        expect(recoveryAgain._tag).toBe("Failure")
        expect(loginAgain._tag).toBe("Failure")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("does not charge the global budget when a recipient is blocked", () =>
    Effect.gen(function* () {
      const layer = makeLayer(
        withLimits({
          sendRecoveryHourly: { ...defaultEmailRateLimitPolicies.sendRecoveryHourly, limit: 2 },
          sendRecipient: { ...defaultEmailRateLimitPolicies.sendRecipient, limit: 1 }
        })
      )
      yield* Effect.gen(function* () {
        const first = yield* send("a@example.com").pipe(Effect.exit)
        const blocked = yield* send("a@example.com").pipe(Effect.exit)
        const third = yield* send("c@example.com").pipe(Effect.exit)
        expect(first._tag).toBe("Success")
        expect(blocked._tag).toBe("Failure")
        expect(third._tag).toBe("Success")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("charges the recipients rewritten by onEmailSend", () =>
    Effect.gen(function* () {
      const rewritten = MiraPlugin.define({
        onEmailSend: {
          handler: (ctx) =>
            Effect.succeed({ ...ctx, message: { ...ctx.message, to: "victim@example.com" } })
        }
      })
      const layer = makeLayer(
        withLimits({
          sendRecipient: { ...defaultEmailRateLimitPolicies.sendRecipient, limit: 1 }
        }),
        { plugins: [rewritten] }
      )
      yield* Effect.gen(function* () {
        const first = yield* send("a@example.com").pipe(Effect.exit)
        const second = yield* send("b@example.com").pipe(Effect.exit)
        expect(first._tag).toBe("Success")
        expect(second._tag).toBe("Failure")
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("fails closed when the store is down", () =>
    Effect.gen(function* () {
      const failing: RateLimitStoreShape = {
        increment: () =>
          Effect.fail(new RateLimitStoreError({ message: "down", retryable: true })),
        prune: () => Effect.void
      }
      const layer = makeLayer(defaultEmailRateLimitPolicies, {
        limiter: makeRateLimiter(failing)
      })
      const result = yield* send("a@example.com").pipe(Effect.provide(layer), Effect.exit)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(String(result.cause)).toContain("RateLimitUnavailableError")
      }
    })
  )

  it.effect("does not fire onEmailError for a rate limit", () =>
    Effect.gen(function* () {
      let errors = 0
      const observer = MiraPlugin.define({
        onEmailError: {
          handler: () =>
            Effect.sync(() => {
              errors += 1
            })
        }
      })
      const layer = makeLayer(
        withLimits({
          sendRecoveryHourly: { ...defaultEmailRateLimitPolicies.sendRecoveryHourly, limit: 0 }
        }),
        { plugins: [observer] }
      )
      const result = yield* send("a@example.com").pipe(Effect.provide(layer), Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(errors).toBe(0)
    })
  )
})
