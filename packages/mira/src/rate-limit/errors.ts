import { Data } from "effect"

/** A storage failure in the rate-limit store. Internal; the limiter maps it. */
export class RateLimitStoreError extends Data.TaggedError("RateLimitStoreError")<{
  readonly message: string
  readonly retryable: boolean
}> {}

/** The caller exceeded a policy or a cooldown. */
export class RateLimitedError extends Data.TaggedError("RateLimitedError")<{
  readonly retryAfterSeconds: number
  readonly policy: string
  readonly scope: "request" | "send" | "cooldown"
}> {}

/** The limiter could not make a decision for a send. Fail closed with 503. */
export class RateLimitUnavailableError extends Data.TaggedError("RateLimitUnavailableError")<{
  readonly message: string
}> {}
