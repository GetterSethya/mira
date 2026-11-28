# Rate-Limit Service

## Overview

A storage-neutral fixed-window rate limiter. `RateLimiter` is a `Context.Service`
implemented by `RateLimiterLive` from a `RateLimitStore`. The store is the only storage
boundary: an in-memory implementation for tests, a SQL implementation for the app, and
any future Redis/Postgres implementation. Email, HTTP, and auth code depend on
`RateLimiter`/`RateLimitStore`, never on `SqlClient` or a dialect name.

## Interface

- `RateLimitPolicy` — `name`, `limit`, `windowMs`, `onStoreError: "allow" | "deny"` [types.ts:RateLimitPolicy]
- `RateLimitStore` — `Context.Service` with `increment(entries)` and `prune(before)` [types.ts:RateLimitStore]
- `RateLimiter` — `Context.Service` with `consume(policy, key, cost?)` and `consumeMany(requests)` [types.ts:RateLimiter]
- `RateLimitKeySecret` — `Context.Service<Redacted<string>>` used to HMAC keys [types.ts:RateLimitKeySecret]
- `RateLimitedError` — `retryAfterSeconds`, `policy`, `scope: request | send | cooldown` [errors.ts:RateLimitedError]
- `RateLimitUnavailableError` — send-path store failure [errors.ts:RateLimitUnavailableError]
- `RateLimitStoreError` — internal store failure with a `retryable` flag [errors.ts:RateLimitStoreError]
- `InMemoryRateLimiterLive` — fresh in-memory store per layer build [memory.ts:InMemoryRateLimiterLive]
- `SqlRateLimitStoreLive` (alias `SqliteRateLimitStoreLive`), `RateLimiterLive`, `RateLimitKeySecretLive` [sql.ts:SqlRateLimitStoreLive]
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
- `increment` runs one reporting read, a read-only pre-blocked fast return, then one
  conditional upsert per entry in sorted bucket order. The upsert is
  `INSERT ... SELECT ... WHERE cost <= limit ON CONFLICT ... DO UPDATE ... WHERE used + cost <= limit
  RETURNING used`; zero rows means blocked, and a blocked batch writes nothing for that
  entry. Any allowed entry in a mixed batch is rolled back when a later entry blocks.
- `prune` orders its candidate subquery by `bucket` to match the batch write order.
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

- Reads and writes `_rate_limits` in the application database.
- SQLite and libSQL keep the non-transactional DDL path; PostgreSQL uses a
  transaction-scoped advisory lock and a request-path `lock_timeout`.
- `RETURNING` requires SQLite 3.35+ or PostgreSQL; the bundled `node:sqlite` engine
  supports it.
- The prune cap is 1000 rows per 60 seconds per process. Sustained creation above
  about 16.7 new buckets per second outpaces pruning; #29 must measure and tune it
  before claiming high-throughput support.
- No network, filesystem, or environment access.

## Verification

- Run: `pnpm --filter @gettersethya/mira test -- rate-limit email auth-email-rate-limit`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
- The storage spike is in `.egm/email-rate-limit-2026-11-14/spike-rate-limit.md`.

## MySQL and MariaDB rate limits (issue #30)

- `_rate_limits.bucket` uses `bucketColumnType`: `VARCHAR(512)` with `utf8mb4_0900_bin` on MySQL, `TEXT` elsewhere. The store rejects a bucket over `bucketMaxLength` code points; MySQL enforces 512, SQLite and PostgreSQL impose no new cap.
- `prune` uses one derived-table statement on every dialect because MySQL rejects `LIMIT` directly inside an `IN` subquery.
- SQLite/PostgreSQL keep the guarded `ON CONFLICT ... WHERE ... RETURNING` path. MySQL uses one transaction with `SELECT ... FOR UPDATE`, an explicit guard, and a write per bucket. A blocked bucket fails the transaction so every earlier write rolls back; the blocked counts are the locked pre-batch values.
- Duplicate buckets share the in-memory map. A duplicate-key error from a concurrent insert restarts the transaction once; one retry follows the first lock failure.
