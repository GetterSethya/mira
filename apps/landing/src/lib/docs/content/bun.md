Run the same app on Bun with native filesystem, HTTP, SQLite, hashing, and images. The platform preset swaps runtime services. Your collection definitions and builder chain stay as they are.

This page assumes the builder from [server](../server/). Only the platform and database presets change.

## Requirements

Bun **1.3.14 or newer**. `Bun.Image` landed in 1.3.14 and backs the native thumbnail path. `BunPlatform` checks `Bun.version` when the layer builds and fails with a clear error on older runtimes. The tested baseline is 1.4.2.

## Quick start

Install the same packages you would on Node. `@gettersethya/mira` includes the Bun presets. There is no separate package.

```install
bun add @gettersethya/mira effect@4.0.0
```

Import the Bun presets from the Bun entry so TypeScript sees the Bun declarations, and collection builders from the server root:

```typescript
import { BunPlatform, BunSqliteDatabase, LocalFileStorage, Mira } from "@gettersethya/mira/bun"
import { BaseCollection, Field } from "@gettersethya/mira"

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true })
})

Mira.builder()
  .platform(BunPlatform)
  .database(BunSqliteDatabase({ filename: "./data.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Posts])
  .build()
  .serve()
```

Run it with `bun run src/index.ts`. `BunPlatform.runMain` hands the effect to `BunRuntime.runMain`, so `serve()` uses Bun's signal and shutdown handling.

## Import paths

| Import | Runtime |
|---|---|
| `@gettersethya/mira/bun` | Explicit Bun entry. Use this for TypeScript. |
| `@gettersethya/mira` | Resolves the `bun` export condition under Bun and the Node entry everywhere else. |

The root condition is a convenience. Bun resolves `bun` before `default`. Node and bundlers that do not know the condition keep the Node entry. TypeScript only sees the Bun declarations from the root when `moduleResolution` is `bundler` and `customConditions` includes `bun`. Otherwise import `@gettersethya/mira/bun` for the Bun types.

## What is native and what is reused

Native Bun:

- `BunHttpServer` via `HttpServerFactory`
- `BunFileSystem` and `BunPath`
- `BunRuntime.runMain`
- `@effect/sql-sqlite-bun` (`bun:sqlite`)
- `Bun.CryptoHasher` for SHA-256 and HMAC-SHA-256, including rate-limit keys and the per-request `pwf` credential binding
- `Bun.password` for Argon2id password hashing and verification
- `Bun.randomUUIDv7()` for generated UUIDs (file keys and other `CryptoService` consumers)
- `Bun.Image` for `contain` and `fill` thumbnail resizing and JPEG/PNG/WebP encoding

Reused Node-compatible layers:

- `node:crypto` async `scrypt` only to verify legacy `scrypt$<salt>$<hash>` password rows
- `nodemailer` for SMTP
- `@cf-wasm/photon` for `cover` thumbnails and as the image fallback
- The dashboard plugin, rate limiter, auth flows, and storage adapters

Bun 1.4.2 implements the APIs these layers need. The native layers are selected by `BunPlatform`, so app code does not change.

## Native Bun APIs

### Hashing

`sha256Base64Url`, `hmacSha256Base64Url`, and `hmacSha256Base64` detect `Bun.CryptoHasher` and run synchronously in native Bun. Node and edge runtimes keep the WebCrypto fallback. The output is byte-identical across runtimes.

### Passwords

`BunAuthServiceLayer` hashes new passwords with `Bun.password` using OWASP-recommended Argon2id parameters (19 MiB, 2 iterations). Verification auto-detects the encoded algorithm. Rows that start with `scrypt$` are verified with the shared async scrypt verifier, so a Node-created database moves to Bun without resetting passwords.

New Bun passwords are stored as `$argon2id$v=19$...`. The Node platform continues to write the `scrypt$<salt>$<hash>` format.

A successful login also upgrades a legacy `scrypt$...` row to Argon2id on Bun. The upgrade is best-effort: if hashing or the write fails, the login still succeeds with the old row. `BunPortablePlatform` opts out of Argon2id, so it does not rehash.

### Moving between runtimes

The migration direction matters:

- **Node → Bun** works without a password reset. Legacy `scrypt$...` rows verify on Bun.
- **Bun → Node** is not automatic. The Node platform has no Argon2id verifier, so it fails closed on `$argon2id$...` rows and those users cannot log in until they reset their password or the database moves back to Bun.
- If you need bidirectional portability, use `BunPortablePlatform` instead of `BunPlatform`. It keeps every other native Bun layer but hashes new passwords with the shared scrypt implementation, so both runtimes can verify them.

### Login rate limiting

Password login consumes two budgets before the user lookup: 100 attempts per IP and 10 per submitted recipient in a 15-minute window. The generous IP budget tolerates shared NAT/office egress while the recipient budget is the brute-force control. Unknown addresses are charged too, so the endpoint is not an account-enumeration oracle. A store failure fails closed with `503 rate_limit_unavailable`. Override the limits with `.rateLimits({ authPolicies })`.

### Images

`ThumbnailServiceBunLive` uses `Bun.Image` for `contain` (`WxHb`) and `fill` (`WxHf`) specs. The work runs off the JavaScript thread and is encoded back to the input MIME type (JPEG quality 80). `Bun.Image` does not expose a centre-crop operation, so `cover` (`WxH`, the default) uses Photon. A native `Bun.Image` failure also falls back to Photon rather than failing the request.

Before either backend decodes pixels, a platform-neutral PNG/JPEG/WebP header parser enforces a 64-megapixel budget, including an independent `width * height` check. A compressed image bomb is rejected before allocation. On supported Bun the native path also passes `maxPixels` to `Bun.Image.metadata()`. The Photon path (Node and the Bun `cover`/fallback) uses the header parser.

Use `makeThumbnailServiceBunLive({ maxPixels, allowPhotonFallback })` for a different Bun budget or for a strict no-fallback layer. `allowPhotonFallback: false` is how the smoke proves the native path actually ran. The Node/Photon layer has the same knob: `makeThumbnailServicePhotonLive({ maxPixels })`.

### UUIDs

`BunCryptoLayer` uses `Bun.randomUUIDv7()`, giving time-sortable ids. If the runtime does not expose it, it falls back to `crypto.randomUUID()` (v4).

## SQLite

`BunSqliteDatabase` pairs the Bun SQLite client with the existing SQLite dialect. Migrations, `_config`, `_auth_challenges`, `_revoked_tokens`, and `_rate_limits` use the same SQL as the Node preset. The Bun driver enables WAL and a busy timeout by default. Telemetry is driver-neutral: keep a dedicated telemetry database or use shared storage when a second connection is impossible.

`SqliteDatabase` is also exported from the Bun entry as an alias for `BunSqliteDatabase`, so code that follows the Node docs keeps working after switching imports.

libSQL works on Bun too. The Bun entry exports `LibsqlDatabase` and `TursoDatabase`, and the root import resolves to it under Bun:

```typescript
import { BunPlatform, LibsqlDatabase, LocalFileStorage, Mira } from "@gettersethya/mira/bun"

Mira.builder()
  .platform(BunPlatform)
  .database(LibsqlDatabase({ url: "file:./bun-data.db" }))
  .storage(LocalFileStorage({ directory: "./bun-uploads" }))
  .collections([Posts])
  .build()
  .serve()
```

The local preset applies WAL, `foreign_keys=OFF`, `busy_timeout=5000`, and an optional `synchronous` mode. Remote libSQL skips writable pragmas. `TursoDatabase` is an alias. The Bun smoke covers a local libSQL file and the Docker sqld job covers a remote Bun connection.

## PostgreSQL

The Bun entry exports `PostgresDatabase`, backed by `@effect/sql-pg`. PostgreSQL 15+ is supported; 17.12 is the validated version. The preset runs a `SELECT 1` readiness probe at boot and supports `maxConnections`, `idleTimeout`, `prepare`, `ssl`, and `migrateAtStartup`:

```typescript
import { BunPlatform, LocalFileStorage, Mira, PostgresDatabase } from "@gettersethya/mira/bun"
import { Redacted } from "effect"

Mira.builder()
  .platform(BunPlatform)
  .database(PostgresDatabase({
    url: Redacted.make(process.env.DATABASE_URL!),
    maxConnections: 10,
    prepare: false
  }))
  .storage(LocalFileStorage({ directory: "./bun-uploads" }))
  .collections([Posts])
  .build()
  .serve()
```

Set `prepare: false` for a statement-mode pooler such as PgBouncer. The Bun smoke `packages/mira/tests/databases/postgres-bun.e2e.ts` runs the preset, migrates a collection, inserts, and asserts a native boolean and a restarted `BIGINT` sequence. It runs only when `MIRA_TEST_POSTGRES_URL` is set.

## MySQL and MariaDB

The Bun entry also exports `MysqlDatabase`, backed by `@effect/sql-mysql2`. MySQL 8.4 and MariaDB 11.4.6 or newer are supported; 8.4.13 and 11.4.13 are the validated versions. The preset supports `maxConnections`, `connectionTTL`, `ssl`, `connectTimeout`, `disablePreparedStatements`, and `migrateAtStartup`:

```typescript
import { BunPlatform, LocalFileStorage, Mira, MysqlDatabase } from "@gettersethya/mira/bun"
import { Redacted } from "effect"

Mira.builder()
  .platform(BunPlatform)
  .database(MysqlDatabase({
    url: Redacted.make(process.env.MYSQL_URL!),
    maxConnections: 10,
    ssl: true
  }))
  .storage(LocalFileStorage({ directory: "./bun-uploads" }))
  .collections([Posts])
  .build()
  .serve()
```

The Bun smoke `packages/mira/tests/databases/mysql-bun.e2e.ts` runs the preset against MySQL and MariaDB, migrates a collection, inserts two rows above 2^53, and asserts a string `seqId` and `0`/`1` booleans. It runs in the MySQL CI job with `MIRA_TEST_MYSQL_URL` set to each engine URL in turn.

## Telemetry

Console telemetry is the default and has no SQLite dependency. To persist logs and spans under Bun, use a Bun database preset for dedicated telemetry:

```ts
import { BunSqliteDatabase, makeTelemetryLayer } from "@gettersethya/mira/bun"

.telemetry(makeTelemetryLayer({
  storage: {
    mode: "dedicated",
    database: BunSqliteDatabase({ filename: "mira-logs.db" }),
  },
  logConsole: true,
}))
```

Dedicated mode applies WAL, `synchronous=NORMAL`, and `busy_timeout=5000`, migrates `logs` and `spans` with a `created` index, and serves the admin routes through `TelemetryStore`. `logCleanupCronDef` uses the store, so add it to `.crons([...])`. Set `manageConnection: false` to keep the preset's explicit synchronous setting. Do not reuse the application database for dedicated telemetry; shared storage is available when a second connection is impossible.

## Version pin

The tested set is Bun `1.4.2`, `effect@4.0.0`, `@effect/platform-bun@4.0.0`, `@effect/sql-sqlite-bun@4.0.0`, `@effect/sql-pg@4.0.0`, `@effect/platform-node@4.0.0`, `@effect/sql-sqlite-node@4.0.0`, and `@effect/platform-node-shared@4.0.0`. The supported Bun floor is `1.3.14` (declared in `engines.bun`). The server package pins those platform/SQL packages and narrows its Effect peer range to `~4.0.0`, so a fresh install does not drift to Effect 4.1.x. The workspace also adds a `pnpm.overrides` entry. Keep the set aligned when upgrading.

## Example and smoke

The repository includes:

- `apps/example-bun/src/index.ts`: a Bun app with `Posts` and the dashboard plugin.
- `packages/bun-e2e/src/smoke.ts`: boots the real layer graph on an ephemeral SQLite file, runs migrations, exercises GET/POST collection routes, checks the dashboard status route, sends a real SMTP message through an in-process server, round-trips a file through local storage, verifies the native hash vectors, Argon2id hashing, legacy scrypt verification and rehash eligibility, UUIDv7, native contain/fill thumbnails with Photon disabled, and the pixel-budget guard, checks the rate-limit store, and proves port fallback by occupying the first port.
- `packages/bun-e2e/src/libsql-smoke.ts`: proves the Bun libSQL preset locally and remotely.
- `packages/mira/tests/databases/postgres-bun.e2e.ts`: proves the Bun PostgreSQL preset against a real server.

```bash
bun run apps/example-bun/src/index.ts
bun run packages/bun-e2e/src/smoke.ts
bun run packages/bun-e2e/src/libsql-smoke.ts
```

The `packages/bun-e2e` smoke is the runtime proof. It does not replace the Node test suite. Run `pnpm -r test` for the shared behavior.

## What is not covered

- Deno.
- Bun versions older than `1.3.14`. `BunPlatform` fails fast on them.
- A Bun-native SMTP client. `nodemailer` uses Bun's native `node:net` and TLS implementation.
- Native `cover` thumbnails. `Bun.Image` has no centre-crop operation yet, so `cover` uses Photon.
- Automatic Bun → Node password portability. Use `BunPortablePlatform` if you need it.
- A full Node/Bun CI matrix. CI runs typecheck, the Node test suite, the package build, a packed-tarball install smoke, the Bun smoke, and an example boot on one runner.
- Dashboard telemetry pages that depend on the SQLite log store. The dashboard core and its public bootstrap route work on Bun. The SQLite telemetry backend also works there with `BunSqliteDatabase`, either as a dedicated preset or as shared storage.

## Next

- [Email and auth flows](../email/) for SMTP setup, verification, reset, and the email-change flow.
- [Dashboard plugin](../dashboard/) for the admin UI, `_superadmin`, and the connect sheet.
