Mira runs on Bun through a native platform preset. Filesystem, path, HTTP server, runtime, and SQLite use `@effect/platform-bun` and `@effect/sql-sqlite-bun`; crypto, password hashing, SMTP, thumbnails, and the dashboard reuse the existing implementations.

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

Reused Node-compatible layers:

- `node:crypto` for random bytes, UUIDs, and `scrypt` password hashing
- `nodemailer` for SMTP
- `@cf-wasm/photon` for thumbnails
- The dashboard plugin, rate limiter, auth flows, and storage adapters

Bun 1.4.2 implements the APIs these layers need. A future Bun-native mail or password implementation can replace them without changing the app builder.

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
- `apps/example-bun/src/smoke.ts` — boots the real layer graph on an ephemeral SQLite file, runs migrations, exercises GET/POST collection routes, checks the dashboard status route, sends a real SMTP message through an in-process server, round-trips a file through local storage, resizes a thumbnail, checks the rate-limit store, and proves port fallback by occupying the first port.

```bash
bun run apps/example-bun/src/index.ts
bun run apps/example-bun/src/smoke.ts
```

The smoke is the runtime proof. It does not replace the Node test suite; run `pnpm -r test` for the shared behavior.

## What is not covered

- Deno, Postgres, and MySQL.
- Bun-native SQLite telemetry.
- A Bun-native SMTP or password implementation.
- A full Node/Bun CI matrix. CI runs typecheck, the Node test suite, the package build, a packed-tarball install smoke, the Bun smoke, and an example boot on one runner.
- Dashboard telemetry pages that depend on the SQLite log store. The dashboard core and its public bootstrap route work on Bun; the SQLite telemetry backend is Node-only in this cut.
