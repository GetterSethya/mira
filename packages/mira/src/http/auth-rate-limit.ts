import { Effect, Redacted } from "effect"

import { RateLimitedError, RateLimitUnavailableError } from "@/rate-limit/errors.js"
import {
  AuthRateLimitConfig,
  normalizeIpForRateLimit,
  RateLimitKeySecret,
  RateLimiter,
  rateLimitKey
} from "@/rate-limit/index.js"
import type { RateLimitRequest } from "@/rate-limit/index.js"

/**
 * Consume the password-login request budgets before the user lookup and
 * password verification. Both the submitted recipient and the peer IP are
 * charged; the recipient key is account-agnostic, so unknown addresses are
 * limited too. A store failure fails closed (503) instead of allowing guesses.
 */
export const consumeLoginRequestLimits = (
  email: string,
  ip: string | null
): Effect.Effect<
  void,
  RateLimitedError | RateLimitUnavailableError,
  RateLimiter | RateLimitKeySecret
> =>
  Effect.gen(function* () {
    const secret = Redacted.value(yield* RateLimitKeySecret)
    const policies = yield* AuthRateLimitConfig
    const requests: Array<RateLimitRequest> = []

    const recipientKey = yield* rateLimitKey(
      secret,
      `login:recipient:${email.trim().toLowerCase()}`
    )
    requests.push({ policy: policies.loginRecipient, key: recipientKey })

    const normalizedIp = normalizeIpForRateLimit(ip)
    if (normalizedIp !== null) {
      const ipKey = yield* rateLimitKey(secret, `login:ip:${normalizedIp}`)
      requests.push({ policy: policies.loginIp, key: ipKey })
    } else {
      yield* Effect.logWarning("rate_limit.ip_unavailable", { scope: "auth:login" })
    }

    const limiter = yield* RateLimiter
    const result = yield* limiter.consumeMany(requests)
    if (result.blocked !== null) {
      return yield* Effect.fail(
        new RateLimitedError({
          retryAfterSeconds: result.blocked.retryAfterSeconds,
          policy: result.blocked.policy,
          scope: "request"
        })
      )
    }
  })
