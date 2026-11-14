import { Effect } from "effect"

import { hmacSha256Base64Url } from "@/crypto/hash.js"

import { RateLimitUnavailableError } from "./errors.js"

/**
 * Pseudonymize a rate-limit key with the server secret. A database dump without
 * the app secret is not a list of addresses or IPs.
 */
export const rateLimitKey = (
  secret: string,
  value: string
): Effect.Effect<string, RateLimitUnavailableError> =>
  hmacSha256Base64Url(secret, `rate:${value}`).pipe(
    Effect.mapError((error) => new RateLimitUnavailableError({ message: error.message }))
  )

/**
 * Normalize a peer address for bucketing. IPv4-mapped IPv6 collapses to IPv4;
 * IPv6 buckets by /64 so a single allocation cannot rotate through 2^64 keys.
 * Returns null when the peer address is missing.
 */
export const normalizeIpForRateLimit = (ip: string | null): string | null => {
  if (ip === null) return null
  let value = ip.trim()
  if (value.length === 0) return null

  const zone = value.indexOf("%")
  if (zone !== -1) value = value.slice(0, zone)

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value)
  if (mapped !== null) return mapped[1] ?? null

  if (!value.includes(":")) return value

  const [head, tail] = value.split("::")
  const headParts = head === undefined || head.length === 0 ? [] : head.split(":")
  const tailParts = tail === undefined || tail.length === 0 ? [] : tail.split(":")
  const missing = Math.max(0, 8 - headParts.length - tailParts.length)
  const groups = [
    ...headParts,
    ...Array.from({ length: missing }, () => "0"),
    ...tailParts
  ]
  return groups
    .slice(0, 4)
    .map((group) => group.toLowerCase())
    .join(":")
}
