import { Context, Effect, type Redacted } from "effect"

import type {
  RateLimitedError,
  RateLimitStoreError,
  RateLimitUnavailableError
} from "./errors.js"

export type RateLimitStoreErrorMode = "allow" | "deny"

export interface RateLimitPolicy {
  readonly name: string
  readonly limit: number
  readonly windowMs: number
  /** What a store failure means for this policy. Request policies allow; send policies deny. */
  readonly onStoreError: RateLimitStoreErrorMode
}

export interface RateLimitDecision {
  readonly allowed: boolean
  readonly policy: string
  readonly used: number
  readonly limit: number
  readonly remaining: number
  readonly resetAt: number
  readonly retryAfterSeconds: number
  readonly degraded: boolean
}

export interface RateLimitEntry {
  readonly bucket: string
  readonly limit: number
  readonly cost: number
  readonly expiresAt: number
}

export type RateLimitIncrementResult =
  | { readonly ok: true; readonly counts: ReadonlyArray<number> }
  | {
      readonly ok: false
      readonly blockedIndices: ReadonlyArray<number>
      readonly counts: ReadonlyArray<number>
    }

export interface RateLimitStoreShape {
  /**
   * Atomically check every entry and increment all of them only when every entry
   * would stay within its limit. In the blocked case, no entry is incremented.
   */
  increment(
    entries: ReadonlyArray<RateLimitEntry>
  ): Effect.Effect<RateLimitIncrementResult, RateLimitStoreError>

  /** Best-effort delete of buckets older than the cutoff. */
  prune(before: number): Effect.Effect<void, RateLimitStoreError>
}

export interface RateLimitRequest {
  readonly policy: RateLimitPolicy
  readonly key: string
  readonly cost?: number
}

export interface RateLimitBatchResult {
  readonly decisions: ReadonlyArray<RateLimitDecision>
  readonly blocked: RateLimitDecision | null
}

export interface RateLimiterShape {
  consume(
    policy: RateLimitPolicy,
    key: string,
    cost?: number
  ): Effect.Effect<RateLimitBatchResult, RateLimitUnavailableError>

  consumeMany(
    requests: ReadonlyArray<RateLimitRequest>
  ): Effect.Effect<RateLimitBatchResult, RateLimitUnavailableError>
}

export class RateLimitStore extends Context.Service<RateLimitStore, RateLimitStoreShape>()(
  "RateLimitStore"
) {}

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()("RateLimiter") {}

export class RateLimitKeySecret extends Context.Service<
  RateLimitKeySecret,
  Redacted.Redacted<string>
>()("RateLimitKeySecret") {}

export type RateLimitErrors = RateLimitedError | RateLimitStoreError | RateLimitUnavailableError
