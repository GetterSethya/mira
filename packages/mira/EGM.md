# `@gettersethya/mira` Blueprint

## System Overview

`@gettersethya/mira` is the self-hosted server library. It turns collection definitions
into a running REST API with authentication, access rules, file storage, cursor
pagination, hooks, plugins, crons, telemetry, and an optional dashboard plugin. The
package owns the Effect layer graph, the HTTP server, persistence, migrations, and the
server-side rule engine; the isomorphic collection definitions and client SDK are
re-exported from `@gettersethya/mira-client`.

The runtime is Effect v4. The public entry point is `src/index.ts`; the implementation is
documented per component under [`src`](./src/EGM.md). Node-specific code is confined to
the platform implementations aggregated by `platforms/node.ts`.

## Subdirectories & System Boundaries

- [`src`](./src/EGM.md) — the server library implementation: app builder, HTTP, collection
  service, persistence, migrations, dialect, storage, hooks, crons, telemetry, thumbnails,
  platforms, config, crypto, cache, and rules.
- `tests` — Vitest suites for the server components; excluded from the documentation tree.
- `scripts` — build and verification scripts; excluded by `.egmignore`.

## Global Invariants

- The public package surface is the single `.` export backed by `dist/index.js` /
  `dist/index.d.ts` — `[package.json:exports]`.
- `@gettersethya/mira-client` is a runtime dependency and is re-exported by the server
  entry, so collection/client types share one package — `[src/index.ts:CollectionService]`,
  `[package.json:dependencies]`.
- The app builder enforces `platform`, `database`, `storage`, and `collections` at compile
  time before `build()` — `[src/app/builder.ts:MiraBuilder.build]`.
- Auto-migration runs before requests are served; plugin layers are provided after the
  mid layer; the collection-service stack is hooks → cache → base —
  `[src/app/app.ts:MiraApp.buildServiceLayer]`.
- The dialect owns SQL rendering and table rebuilds; the repository is schema-agnostic;
  the collection service owns validation, rules, pagination, and hidden fields —
  `[src/dialect/dialect.ts:Dialect]`, `[src/repository/repository.ts:Repository]`,
  `[src/collection-service/collection-service.ts:CollectionService]`.
- `node:*` imports are confined to `crypto/node.ts`, `http/auth-node.ts`, and
  `http/server-factory-node.ts`, aggregated by `platforms/node.ts` —
  `[src/platforms/node.ts:NodePlatformLayer]`.
- Plugin `adminCollections` are auto-merged and grant their tokens `ctx.admin = true`,
  bypassing rules on the generic collection/file routes — `[src/app/app.ts:MiraApp]`.
- Secrets are `Redacted`; the JWT secret is generated and persisted on first boot —
  `[src/config/config.ts:AppConfigLive]`.

## Global Side Effects

- SQL DDL/DML: migrations, `_collections`, `_migrations`, `_config`, token tables, and
  telemetry tables — `[src/migrator/migrator.ts:MigratorLive]`,
  `[src/http/token-store.ts:TokenStoreLive]`, `[src/telemetry/sqlite-logger.ts:makeSqliteTelemetryLayer]`.
- HTTP server binding with port retry and request handling — `[src/app/app.ts:MiraApp.buildLayer]`.
- File storage reads/writes/deletes and thumbnail cache writes — `[src/storage/storage.ts:FileStorage]`,
  `[src/thumbnail/photon.ts:ThumbnailServicePhotonLive]`.
- Cron fibers, telemetry queues/spans, structured logs — `[src/cron/cron-service.ts:CronService]`,
  `[src/telemetry/tracer.ts:makeConsoleTracer]`.
- Password hashing, JWT signing/verification, CSPRNG entropy — `[src/http/auth-node.ts:NodeAuthServiceLayer]`,
  `[src/http/auth.ts:signJwt]`, `[src/crypto/node.ts:NodeCryptoLayer]`.
- Plugin lifecycle/hook effects and route registration — `[src/app/plugin.ts:MiraPlugin]`.

## System Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
