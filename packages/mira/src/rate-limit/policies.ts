import { Context } from "effect"

import type { RateLimitPolicy } from "./types.js"

export const REQUEST_COOLDOWN_MS = 60_000
export const LOGIN_REQUEST_COOLDOWN_MS = 30_000

export interface EmailRateLimitPolicies {
  readonly requestRecoveryIp: RateLimitPolicy
  readonly requestLoginIp: RateLimitPolicy
  readonly requestRecipient: RateLimitPolicy
  readonly requestCooldown: RateLimitPolicy
  readonly requestLoginCooldown: RateLimitPolicy
  readonly sendRecoveryHourly: RateLimitPolicy
  readonly sendRecoveryDaily: RateLimitPolicy
  readonly sendLoginHourly: RateLimitPolicy
  readonly sendLoginDaily: RateLimitPolicy
  readonly sendNotificationHourly: RateLimitPolicy
  readonly sendNotificationDaily: RateLimitPolicy
  readonly sendCollection: RateLimitPolicy
  readonly sendRecipient: RateLimitPolicy
  readonly dashboardTestEmail: RateLimitPolicy
}

const policy = (
  name: string,
  limit: number,
  windowMs: number,
  onStoreError: RateLimitPolicy["onStoreError"]
): RateLimitPolicy => ({ name, limit, windowMs, onStoreError })

export const defaultEmailRateLimitPolicies: EmailRateLimitPolicies = {
  requestRecoveryIp: policy("email:request:recovery-ip", 60, 15 * 60_000, "allow"),
  requestLoginIp: policy("email:request:login-ip", 30, 15 * 60_000, "allow"),
  requestRecipient: policy("email:request:recipient", 5, 15 * 60_000, "allow"),
  requestCooldown: policy("email:request:cooldown", 1, REQUEST_COOLDOWN_MS, "allow"),
  requestLoginCooldown: policy(
    "email:request:login-cooldown",
    1,
    LOGIN_REQUEST_COOLDOWN_MS,
    "allow"
  ),
  sendRecoveryHourly: policy("email:send:recovery-hourly", 300, 60 * 60_000, "deny"),
  sendRecoveryDaily: policy("email:send:recovery-daily", 3000, 24 * 60 * 60_000, "deny"),
  sendLoginHourly: policy("email:send:login-hourly", 200, 60 * 60_000, "deny"),
  sendLoginDaily: policy("email:send:login-daily", 2000, 24 * 60 * 60_000, "deny"),
  sendNotificationHourly: policy("email:send:notification-hourly", 200, 60 * 60_000, "deny"),
  sendNotificationDaily: policy("email:send:notification-daily", 2000, 24 * 60 * 60_000, "deny"),
  sendCollection: policy("email:send:collection", 300, 60 * 60_000, "deny"),
  sendRecipient: policy("email:send:recipient", 10, 60 * 60_000, "deny"),
  dashboardTestEmail: policy("email:dashboard:test", 5, 60 * 60_000, "allow")
}

export const EmailRateLimitConfig = Context.Reference<EmailRateLimitPolicies>(
  "mira/EmailRateLimitConfig",
  { defaultValue: () => defaultEmailRateLimitPolicies }
)

export interface AuthRateLimitPolicies {
  readonly loginIp: RateLimitPolicy
  readonly loginRecipient: RateLimitPolicy
}

/**
 * Password-login limits. These fail closed: a store outage returns 503 instead
 * of letting unlimited password guesses through. The recipient limit is keyed
 * by the submitted address, including unknown addresses, so the endpoint does
 * not become an account-enumeration oracle.
 */
export const defaultAuthRateLimitPolicies: AuthRateLimitPolicies = {
  // The per-recipient budget is the brute-force control. The IP budget is
  // deliberately generous enough for shared NAT/office egress.
  loginIp: policy("auth:login:ip", 100, 15 * 60_000, "deny"),
  loginRecipient: policy("auth:login:recipient", 10, 15 * 60_000, "deny")
}

export const AuthRateLimitConfig = Context.Reference<AuthRateLimitPolicies>(
  "mira/AuthRateLimitConfig",
  { defaultValue: () => defaultAuthRateLimitPolicies }
)

export const assertValidAuthRateLimitPolicies = (policies: AuthRateLimitPolicies): void => {
  for (const policy of [policies.loginIp, policies.loginRecipient]) {
    if (policy.onStoreError !== "deny") {
      throw new Error(
        `Rate-limit policy "${policy.name}" is an auth policy and must use onStoreError: "deny"`
      )
    }
  }
}

/**
 * A request batch and a send batch must not mix store-error modes, because a
 * store failure is handled once per batch. Fail at boot instead of silently
 * disabling every request limit.
 */
export const assertValidEmailRateLimitPolicies = (policies: EmailRateLimitPolicies): void => {
  const requestPolicies = [
    policies.requestRecoveryIp,
    policies.requestLoginIp,
    policies.requestRecipient,
    policies.requestCooldown,
    policies.requestLoginCooldown,
    policies.dashboardTestEmail
  ]
  const sendPolicies = [
    policies.sendRecoveryHourly,
    policies.sendRecoveryDaily,
    policies.sendLoginHourly,
    policies.sendLoginDaily,
    policies.sendNotificationHourly,
    policies.sendNotificationDaily,
    policies.sendCollection,
    policies.sendRecipient
  ]
  for (const policy of requestPolicies) {
    if (policy.onStoreError !== "allow") {
      throw new Error(
        `Rate-limit policy "${policy.name}" is a request policy and must use onStoreError: "allow"`
      )
    }
  }
  for (const policy of sendPolicies) {
    if (policy.onStoreError !== "deny") {
      throw new Error(
        `Rate-limit policy "${policy.name}" is a send policy and must use onStoreError: "deny"`
      )
    }
  }
}

export type EmailPurposeClass = "recovery" | "login" | "notification"

export const emailPurposeClass = (purpose: string): EmailPurposeClass => {
  switch (purpose) {
    case "password_reset":
    case "verify_email":
      return "recovery"
    case "login_otp":
    case "passwordless_otp":
      return "login"
    default:
      return "notification"
  }
}
