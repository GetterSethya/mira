import { Layer, Redacted } from "effect"

import {
  defaultEmailRateLimitPolicies,
  EmailRateLimitConfig,
  InMemoryRateLimiterLive,
  RateLimitKeySecret
} from "@/rate-limit/index.js"
import type { EmailRateLimitPolicies, RateLimitPolicy } from "@/rate-limit/index.js"

const high = (policy: RateLimitPolicy): RateLimitPolicy => ({
  ...policy,
  limit: Math.max(policy.limit, 10_000)
})

/** High limits so unrelated router tests do not trip the email policies. */
export const emailRateLimitTestConfig: EmailRateLimitPolicies = {
  requestRecoveryIp: high(defaultEmailRateLimitPolicies.requestRecoveryIp),
  requestLoginIp: high(defaultEmailRateLimitPolicies.requestLoginIp),
  requestRecipient: high(defaultEmailRateLimitPolicies.requestRecipient),
  requestCooldown: high(defaultEmailRateLimitPolicies.requestCooldown),
  requestLoginCooldown: high(defaultEmailRateLimitPolicies.requestLoginCooldown),
  sendRecoveryHourly: high(defaultEmailRateLimitPolicies.sendRecoveryHourly),
  sendRecoveryDaily: high(defaultEmailRateLimitPolicies.sendRecoveryDaily),
  sendLoginHourly: high(defaultEmailRateLimitPolicies.sendLoginHourly),
  sendLoginDaily: high(defaultEmailRateLimitPolicies.sendLoginDaily),
  sendNotificationHourly: high(defaultEmailRateLimitPolicies.sendNotificationHourly),
  sendNotificationDaily: high(defaultEmailRateLimitPolicies.sendNotificationDaily),
  sendCollection: high(defaultEmailRateLimitPolicies.sendCollection),
  sendRecipient: high(defaultEmailRateLimitPolicies.sendRecipient),
  dashboardTestEmail: high(defaultEmailRateLimitPolicies.dashboardTestEmail)
}

/** Fresh in-memory limiter plus a fixed key secret for router-level tests. */
export const rateLimitTestLayer = Layer.mergeAll(
  InMemoryRateLimiterLive,
  Layer.succeed(RateLimitKeySecret, Redacted.make("mira-test-rate-limit-secret")),
  Layer.succeed(EmailRateLimitConfig, emailRateLimitTestConfig)
)
