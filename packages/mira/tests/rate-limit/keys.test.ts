import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vitest"

import { normalizeIpForRateLimit, rateLimitKey } from "@/rate-limit/index.js"

describe("rate-limit keys", () => {
  it("normalizes IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeIpForRateLimit("::ffff:1.2.3.4")).toBe("1.2.3.4")
    expect(normalizeIpForRateLimit("1.2.3.4")).toBe("1.2.3.4")
  })

  it("buckets IPv6 by /64", () => {
    expect(normalizeIpForRateLimit("2001:db8::1")).toBe("2001:db8:0:0")
    expect(normalizeIpForRateLimit("2001:db8::2")).toBe("2001:db8:0:0")
    expect(normalizeIpForRateLimit("2001:db8:1::1")).toBe("2001:db8:1:0")
    expect(normalizeIpForRateLimit("fe80::1%eth0")).toBe("fe80:0:0:0")
  })

  it("returns null for a missing or empty address", () => {
    expect(normalizeIpForRateLimit(null)).toBeNull()
    expect(normalizeIpForRateLimit("")).toBeNull()
    expect(normalizeIpForRateLimit("   ")).toBeNull()
  })

  it.effect("HMAC keys are stable and secret-bound", () =>
    Effect.gen(function* () {
      const one = yield* rateLimitKey("secret-a", "email:user@example.com")
      const two = yield* rateLimitKey("secret-a", "email:user@example.com")
      const otherSecret = yield* rateLimitKey("secret-b", "email:user@example.com")
      const otherValue = yield* rateLimitKey("secret-a", "email:other@example.com")
      expect(one).toBe(two)
      expect(otherSecret).not.toBe(one)
      expect(otherValue).not.toBe(one)
      expect(one).toMatch(/^[A-Za-z0-9_-]+$/)
    })
  )
})
