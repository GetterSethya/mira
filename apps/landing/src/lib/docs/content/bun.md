Mira runs on Bun through a native platform preset. Filesystem, path, HTTP server, runtime, SQLite, hashing, password hashing, UUIDs, and the common thumbnail paths use Bun's native APIs. SMTP reuses `nodemailer` (backed by Bun's native sockets), and `cover` thumbnails fall back to Photon because `Bun.Image` has no centre-crop primitive yet.

## Quick start

Install the same packages you would on Node. `@gettersethya/mira` includes the Bun presets; there is no separate package.

```install
bun add @gettersethya/mira effect@4.0.0
```

Import from the Bun entry so TypeScript sees the Bun declarations:

```typescript
import {
  BaseCollection,
  BunPlatform,
  BunSqliteDatabase,
  Field,
  LocalFileStorage,
  Mira
} from "@gettersethya/mira/bun"

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
| `@gettersethya/mira/bun` | Explicit Bun entry; use this for TypeScript. |
| `@gettersethya/mira` | Resolves the `bun` export condition under Bun and the Node entry everywhere else. |

The root condition is a convenience. Bun resolves `bun` before `default`; Node and bundlers that do not know the condition keep the Node entry. TypeScript only sees the Bun declarations from the root when `moduleResolution` is `bundler` and `customConditions` includes `bun`; otherwise import `@gettersethya/mira/bun` for the Bun types.

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

New Bun passwords are stored as `$argon2id$v=19$...`; the Node platform continues to write the `scrypt$<salt>$<hash>` format.

### Moving between runtimes

The migration direction matters:

- **Node → Bun** works without a password reset. Legacy `scrypt$...` rows verify on Bun.
- **Bun → Node** is not automatic. The Node platform has no Argon2id verifier, so it fails closed on `$argon2id$...` rows and those users cannot log in until they reset their password or the database moves back to Bun.
- If you need bidirectional portability, use `BunPortablePlatform` instead of `BunPlatform`. It keeps every other native Bun layer but hashes new passwords with the shared scrypt implementation, so both runtimes can verify them.

### Images

`ThumbnailServiceBunLive` uses `Bun.Image` for `contain` (`WxHb`) and `fill` (`WxHf`) specs. The work runs off the JavaScript thread and is encoded back to the input MIME type (JPEG quality 80). `Bun.Image` does not expose a centre-crop operation, so `cover` (`WxH`, the default) uses Photon. A native `Bun.Image` failure also falls back to Photon rather than failing the request.

Before either backend decodes pixels, the layer reads the header with `Bun.Image.metadata()` and enforces a 64-megapixel budget, including an independent `width * height` check. A compressed image bomb is rejected before allocation, and the guard also covers the Photon path. Use `makeThumbnailServiceBunLive({ maxPixels, allowPhotonFallback })` for a different budget or for a strict no-fallback layer; `allowPhotonFallback: false` is how the smoke proves the native path actually ran.

The preflight needs `Bun.Image` (Bun 1.3.14+; the tested baseline is 1.4.2). On an older Bun the layer falls straight through to Photon without a pixel preflight.

### UUIDs

`BunCryptoLayer` uses `Bun.randomUUIDv7()`, giving time-sortable ids. If the runtime does not expose it, it falls back to `crypto.randomUUID()` (v4).

## SQLite

`BunSqliteDatabase` pairs the Bun SQLite client with the existing SQLite dialect. Migrations, `_config`, `_auth_challenges`, `_revoked_tokens`, and `_rate_limits` use the same SQL as the Node preset. The Bun driver enables WAL and a busy timeout by default. The Node SQLite telemetry layer is separate and is not part of the Bun entry.

`SqliteDatabase` is also exported from the Bun entry as an alias for `BunSqliteDatabase`, so code that follows the Node docs keeps working after switching imports.

## Telemetry

Console telemetry is the default and has no Node SQLite dependency. The SQLite telemetry layer (`makeSqliteTelemetryLayer`) is Node-only in this cut because it imports `@effect/sql-sqlite-node`; the Bun entry does not export it. Use the default console layer; a driver-neutral SQLite telemetry layer is a follow-up.

## Version pin

The tested set is `effect@4.0.0`, `@effect/platform-bun@4.0.0`, `@effect/sql-sqlite-bun@4.0.0`, `@effect/platform-node@4.0.0`, `@effect/sql-sqlite-node@4.0.0`, and `@effect/platform-node-shared@4.0.0`. The server package pins those platform/SQL packages and narrows its Effect peer range to `~4.0.0`, so a fresh install does not drift to Effect 4.1.x. The workspace also adds a `pnpm.overrides` entry. Keep the set aligned when upgrading.

## Example and smoke

The repository includes:

- `apps/example-bun/src/index.ts` — a Bun app with `Posts` and the dashboard plugin.
- `apps/example-bun/src/smoke.ts` — boots the real layer graph on an ephemeral SQLite file, runs migrations, exercises GET/POST collection routes, checks the dashboard status route, sends a real SMTP message through an in-process server, round-trips a file through local storage, verifies the native hash vectors, Argon2id hashing, legacy scrypt verification, UUIDv7, native contain/fill thumbnails with Photon disabled, and the pixel-budget guard, checks the rate-limit store, and proves port fallback by occupying the first port.

```bash
bun run apps/example-bun/src/index.ts
bun run apps/example-bun/src/smoke.ts
```

The smoke is the runtime proof. It does not replace the Node test suite; run `pnpm -r test` for the shared behavior.

## What is not covered

- Deno, Postgres, and MySQL.
- Bun-native SQLite telemetry.
- A Bun-native SMTP client. `nodemailer` uses Bun's native `node:net` and TLS implementation.
- Native `cover` thumbnails. `Bun.Image` has no centre-crop operation yet, so `cover` uses Photon.
- Automatic Bun → Node password portability. Use `BunPortablePlatform` if you need it.
- A pixel-budget preflight on the pure Node/Photon path, or on Bun versions without `Bun.Image`. The Bun 1.4.2 layer guards both its native and Photon paths.
- A full Node/Bun CI matrix. CI runs typecheck, the Node test suite, the package build, a packed-tarball install smoke, the Bun smoke, and an example boot on one runner.
- Dashboard telemetry pages that depend on the SQLite log store. The dashboard core and its public bootstrap route work on Bun; the SQLite telemetry backend is Node-only in this cut.
