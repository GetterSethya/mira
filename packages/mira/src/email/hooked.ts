import { Effect, Layer, Redacted } from "effect"

import { HookService } from "@/hooks/hook-service.js"
import type { EmailSendHookContext } from "@/hooks/types.js"
import {
  EmailRateLimitConfig,
  emailPurposeClass,
  RateLimitKeySecret,
  RateLimiter,
  RateLimitedError,
  rateLimitKey
} from "@/rate-limit/index.js"
import type { RateLimitRequest } from "@/rate-limit/index.js"

import { EmailService } from "./types.js"
import type { EmailMessage } from "./types.js"

const headerValue = (message: EmailMessage, name: string): string | null => {
  for (const [key, value] of Object.entries(message.headers ?? {})) {
    if (key.toLowerCase() === name && typeof value === "string") return value
  }
  return null
}

const recipientsOf = (message: EmailMessage): ReadonlyArray<string> => {
  const recipients = new Set<string>()
  const add = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length > 0) recipients.add(trimmed)
  }

  if (typeof message.to === "string") add(message.to)
  else for (const value of message.to) add(value)

  for (const header of ["cc", "bcc"]) {
    const value = headerValue(message, header)
    if (value === null) continue
    for (const part of value.split(",")) add(part)
  }

  return [...recipients]
}

/**
 * Decorator that routes every email through the plugin hooks and the send
 * budgets before and after the base transport. Only this layer's output is
 * provided to the app.
 */
export const makeHookedEmailServiceLayer = () =>
  Layer.effect(
    EmailService,
    Effect.gen(function* () {
      const base = yield* EmailService
      const hooks = yield* HookService
      const limiter = yield* RateLimiter
      const keySecret = yield* RateLimitKeySecret
      const policies = yield* EmailRateLimitConfig

      const send = (message: Parameters<typeof base.send>[0], options: Parameters<typeof base.send>[1]) =>
        Effect.gen(function* () {
          const context: EmailSendHookContext = {
            message,
            purpose: options.purpose,
            collection: options.collection ?? null,
            userId: options.userId ?? null,
            originalTo: message.to,
            skip: false
          }
          const hooked = yield* hooks.runEmailSend(context)
          if (hooked.skip) {
            return {
              messageId: "",
              accepted: [],
              rejected: []
            }
          }

          const effectiveOptions = {
            ...options,
            purpose: hooked.purpose,
            ...((hooked.collection ?? options.collection) === undefined
              ? {}
              : { collection: hooked.collection ?? options.collection }),
            ...((hooked.userId ?? options.userId) === undefined
              ? {}
              : { userId: hooked.userId ?? options.userId })
          }

          if (base.enabled) {
            const recipients = recipientsOf(hooked.message)
            const cost = Math.max(1, recipients.length)
            const purposeClass = emailPurposeClass(effectiveOptions.purpose)
            const hourly =
              purposeClass === "recovery"
                ? policies.sendRecoveryHourly
                : purposeClass === "login"
                  ? policies.sendLoginHourly
                  : policies.sendNotificationHourly
            const daily =
              purposeClass === "recovery"
                ? policies.sendRecoveryDaily
                : purposeClass === "login"
                  ? policies.sendLoginDaily
                  : policies.sendNotificationDaily

            const requests: Array<RateLimitRequest> = [
              { policy: hourly, key: "global", cost },
              { policy: daily, key: "global", cost },
              {
                policy: policies.sendCollection,
                key: `${effectiveOptions.collection ?? "custom"}:${purposeClass}`,
                cost
              }
            ]

            const secret = Redacted.value(keySecret)
            for (const recipient of recipients) {
              const key = yield* rateLimitKey(
                secret,
                `send:${effectiveOptions.purpose}:${recipient}`
              )
              requests.push({ policy: policies.sendRecipient, key, cost: 1 })
            }

            const decision = yield* limiter.consumeMany(requests)
            if (decision.blocked !== null) {
              yield* Effect.logWarning("email.rate_limited", {
                purpose: effectiveOptions.purpose,
                collection: effectiveOptions.collection ?? null,
                policy: decision.blocked.policy
              })
              return yield* Effect.fail(
                new RateLimitedError({
                  retryAfterSeconds: decision.blocked.retryAfterSeconds,
                  policy: decision.blocked.policy,
                  scope: "send"
                })
              )
            }
          }

          const result = yield* base.send(hooked.message, effectiveOptions).pipe(
            Effect.tapError((error) =>
              error._tag === "EmailSendError"
                ? hooks.runEmailError({
                    message: hooked.message,
                    purpose: hooked.purpose,
                    collection: hooked.collection,
                    userId: hooked.userId,
                    error
                  })
                : Effect.void
            )
          )
          yield* hooks.runEmailSent({
            message: hooked.message,
            purpose: hooked.purpose,
            collection: hooked.collection,
            userId: hooked.userId,
            result
          })
          return result
        })

      return {
        enabled: base.enabled,
        send,
        verify: base.verify,
        describe: base.describe
      }
    })
  )
