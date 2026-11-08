# App Config

## Overview

Central application configuration backed by the database rather than environment variables
or config files. On first boot the `AppConfigLive` layer creates the `_config` table,
seeds missing keys with defaults, and generates/persists a `jwt_secret` so issued tokens
survive restarts. Secrets are wrapped in `Redacted`, S3 settings are resolved only when
`use_s3` is true, and the listening port/URL are mutable after start so a server that
falls back to another port can report the real one.

## Interface

- `AppConfig` — `Context.Service` tag providing the `AppConfigShape` [config.ts:AppConfig]
- `AppConfigLive` — layer that talks to `SqlClient.SqlClient` and `CryptoService` to seed and expose the config [config.ts:AppConfigLive]
- `AppConfigShape` (type) — `appName`, `port`, `applicationUrl`, `jwtSecret`, `useS3`, `s3Config`, `logRetentionDays`, optional `updateBoundPort` [types.ts:AppConfigShape]
- `S3Config` (type) — `endpoint`, `bucketName`, `regionName`, `accessKey`, `secret`, with the three secret-ish fields `Redacted` [types.ts:S3Config]
- Barrel re-exports `AppConfig`, `AppConfigLive`, `AppConfigShape`, `S3Config` [index.ts:AppConfig] [index.ts:AppConfigShape]

## Invariants

- `_config` is created if absent as `key TEXT PRIMARY KEY, value TEXT NOT NULL` [config.ts:AppConfigLive]
- Seed defaults are `app_name = "mira"`, `port = "8080"`, `application_url = "http://localhost:<port>"`, `use_s3 = "false"`, `log_retention_days = "30"`; an existing value always wins because `seed` inserts only on a miss [config.ts:AppConfigLive] [config.ts:seed]
- `jwt_secret` is generated as hex of 48 random bytes and inserted only when absent; a stored secret is reused verbatim so tokens survive restarts [config.ts:AppConfigLive]
- `jwtSecret` is always a `Redacted<string>` [config.ts:AppConfigLive]
- S3 keys `s3_endpoint`, `s3_bucket_name`, `s3_region_name`, `s3_access_key`, `s3_secret` are mandatory when `use_s3 = "true"`; a missing one dies via `require` [config.ts:require]
- `s3Config` is `Option.none()` when `useS3` is false and `Option.some(...)` only when true [config.ts:s3Config]
- `useS3` is true only for the exact stored string `"true"` [config.ts:AppConfigLive]
- `port` and `applicationUrl` are getters over mutable bound values; `updateBoundPort` is a no-op when the port is unchanged and otherwise rewrites the URL's port [config.ts:updateBoundPort]
- `replaceUrlPort` leaves unparseable URLs untouched and strips a trailing slash after rewriting [config.ts:replaceUrlPort]
- `updateBoundPort` is optional on the shape so hand-built test configs may omit it [types.ts:AppConfigShape]

## Side Effects

- Emits `CREATE TABLE IF NOT EXISTS _config (...)` via `sql.unsafe` (DDL) [config.ts:AppConfigLive]
- Reads the whole `_config` table with `SqlSchema.findAll` and inserts each missing seed row [config.ts:AppConfigLive] [config.ts:seed]
- Emits `Effect.logInfo` when it generates and persists `jwt_secret` [config.ts:AppConfigLive]
- Consumes the `CryptoService` dependency to generate the initial `jwt_secret` (OS-backed `node:crypto` behind the Node layer) [config.ts:AppConfigLive]
- Mutates in-process `boundPort` / `boundUrl` state via `updateBoundPort` after a port fallback [config.ts:updateBoundPort]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
