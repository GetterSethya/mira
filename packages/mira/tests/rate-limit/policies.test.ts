import { describe, it } from "@effect/vitest"
import { expect } from "vitest"

import {
  assertValidAuthRateLimitPolicies,
  assertValidEmailRateLimitPolicies,
  defaultAuthRateLimitPolicies,
  defaultEmailRateLimitPolicies
} from "@/rate-limit/index.js"

describe("email rate-limit policy validation", () => {
  it("accepts the defaults", () => {
    expect(() => assertValidEmailRateLimitPolicies(defaultEmailRateLimitPolicies)).not.toThrow()
  })

  it("rejects a request policy that fails closed", () => {
    expect(() =>
      assertValidEmailRateLimitPolicies({
        ...defaultEmailRateLimitPolicies,
        requestRecipient: {
          ...defaultEmailRateLimitPolicies.requestRecipient,
          onStoreError: "deny"
        }
      })
    ).toThrow(/request policy/)
  })

  it("rejects a send policy that fails open", () => {
    expect(() =>
      assertValidEmailRateLimitPolicies({
        ...defaultEmailRateLimitPolicies,
        sendRecipient: {
          ...defaultEmailRateLimitPolicies.sendRecipient,
          onStoreError: "allow"
        }
      })
    ).toThrow(/send policy/)
  })
})

describe("auth rate-limit policy validation", () => {
  it("accepts the defaults", () => {
    expect(() => assertValidAuthRateLimitPolicies(defaultAuthRateLimitPolicies)).not.toThrow()
  })

  it("rejects a login policy that fails open", () => {
    expect(() =>
      assertValidAuthRateLimitPolicies({
        ...defaultAuthRateLimitPolicies,
        loginRecipient: {
          ...defaultAuthRateLimitPolicies.loginRecipient,
          onStoreError: "allow"
        }
      })
    ).toThrow(/auth policy/)
  })
})
