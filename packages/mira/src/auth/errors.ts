import { Data } from "effect"

import type { RateLimitedError, RateLimitUnavailableError } from "@/rate-limit/errors.js"

export class ChallengeCryptoError extends Data.TaggedError("ChallengeCryptoError")<{
  readonly message: string
}> {}

export class InvalidCodeError extends Data.TaggedError("InvalidCodeError")<{
  readonly message: string
}> {}

export class InvalidResetTokenError extends Data.TaggedError("InvalidResetTokenError")<{
  readonly message: string
}> {}

export class TooManyAttemptsError extends Data.TaggedError("TooManyAttemptsError")<{
  readonly retryAfterSeconds: number
}> {}

export class EmailFlowDisabledError extends Data.TaggedError("EmailFlowDisabledError")<{
  readonly collection: string
}> {}

export class EmailUnavailableError extends Data.TaggedError("EmailUnavailableError")<{
  readonly message: string
}> {}

export type AuthEmailError =
  | ChallengeCryptoError
  | InvalidCodeError
  | InvalidResetTokenError
  | TooManyAttemptsError
  | RateLimitedError
  | RateLimitUnavailableError
  | EmailFlowDisabledError
  | EmailUnavailableError
