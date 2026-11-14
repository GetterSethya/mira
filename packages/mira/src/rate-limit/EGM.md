# Rate-Limit Service

## Overview

A storage-neutral fixed-window rate limiter. `RateLimiter` is a `Context.Service`
implemented by `RateLimiterLive` from a `RateLimitStore`. The store is the only storage
boundary: an in-memory implementation for tests, a SQLite implementation for the app, and
any future Redis/Postgres implementation. Email, HTTP, and auth code depend on
`RateLimiter`/`RateLimitStore`, never on `SqlClient` or SQLite.

## Interface

- `RateLimitPolicy` — `name`, `limit`, `windowMs`, `onStoreError: "allow" | "deny"` [types.ts:RateLimitPolicy]
- `RateLimitStore` — `Context.Service` with `increment(entries)` and `prune(before)` [types.ts:RateLimitStore]
- `RateLimiter` — `Context.Service` with `consume(policy, key, cost?)` and `consumeMany(requests)` [types.ts:RateLimiter]
- `RateLimitKeySecret` — `Context.Service<Redacted<string>>` used to HMAC keys [types.ts:RateLimitKeySecret]
- `RateLimitedError` — `retryAfterSeconds`, `policy`, `scope: request | send | cooldown` [errors.ts:RateLimitedError]
- `RateLimitUnavailableError` — send-path store failure [errors.ts:RateLimitUnavailableError]
- `RateLimitStoreError` — internal store failure with a `retryable` flag [errors.ts:RateLimitStoreError]
- `InMemoryRateLimiterLive` — fresh in-memory store per layer build [memory.ts:InMemoryRateLimiterLive]
- `SqliteRateLimitStoreLive`, `RateLimiterLive`, `RateLimitKeySecretLive` [sqlite.ts:SqliteRateLimitStoreLive]
- `EmailRateLimitConfig` — `Context.Reference` with the email policy defaults [policies.ts:EmailRateLimitConfig]
- `AuthRateLimitConfig` — `Context.Reference` with the password-login defaults (`auth:login:ip`, `auth:login:recipient`) [policies.ts:AuthRateLimitConfig]
- `defaultAuthRateLimitPolicies`, `assertValidAuthRateLimitPolicies` [policies.ts:defaultAuthRateLimitPolicies]
- `rateLimitKey`, `normalizeIpForRateLimit` [keys.ts:rateLimitKey]

## Invariants

- A bucket is `JSON.stringify([policy.name, key, windowStart])`; the window start is
  `floor(now / windowMs) * windowMs`. A new window is a new row [limiter.ts:makeRateLimiter].
- `increment` checks every entry and increments all or none. A blocked recipient does not
  charge the global or collection budgets [types.ts:RateLimitStoreShape].
- `cost` must be a positive integer. Invalid costs fail with
  `RateLimitUnavailableError`.
- `used` is clamped to `limit + 1` in SQLite; the single-entry fast path uses
  `WHERE used + cost <= limit RETURNING used` [sqlite.ts:SqliteRateLimitStoreLive].
- `prune` deletes rows with `expires_at <= before`; the caller passes a cutoff with a
  five-minute retention margin. Prune failures are logged and never fail a consume.
- A store failure with `onStoreError: "allow"` logs `rate_limit.store_failed` and returns
  degraded `allowed` decisions. With `"deny"` it logs and fails with
  `RateLimitUnavailableError`.
- A batch must not mix allow and deny policies.
- Keys are HMAC-SHA-256 with `RateLimitKeySecret` (the app's JWT secret). Rotating the
  secret changes the key space; old buckets are pruned.
- IP normalization maps IPv4-mapped IPv6 to IPv4, buckets IPv6 by `/64`, and returns null
  for a missing address. A null IP skips the IP policy rather than sharing a bucket.
- Auth login policies must use `onStoreError: "deny"`; boot fails otherwise. The recipient
  key is account-agnostic and is charged for unknown addresses [policies.ts:assertValidAuthRateLimitPolicies].
- Login consumes the recipient and IP budgets in one batch before the user lookup, so a
  blocked attempt cannot reveal whether the account exists [auth-rate-limit.ts:consumeLoginRequestLimits].

## Side Effects

- Reads and writes `_rate_limits` in the application SQLite database.
- The SQLite store is single-node; WAL does not make a network filesystem safe.
- `RETURNING` requires SQLite 3.35+; the bundled `node:sqlite` engine supports it.
- No network, filesystem, or environment access.

## Verification

- Run: `pnpm --filter @gettersethya/mira test -- rate-limit email auth-email-rate-limit`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
- The storage spike is in `.egm/email-rate-limit-2026-11-14/spike-rate-limit.md`.
