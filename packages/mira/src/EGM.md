# Mira Server Source (`packages/mira/src`)

## Overview

`src` is the implementation root of the `@gettersethya/mira` server library. The package
entry `index.ts` re-exports the client SDK plus the server's public builder, presets,
services, repository, hooks, and error types. The implementation is split into seventeen
components: the app/layer composition (`app`), HTTP API (`http`), the collection service
(`collection-service`), persistence and schema machinery (`repository`, `migrator`,
`dialect`, `databases`), cross-cutting runtime services (`cache`, `config`, `cron`,
`crypto`, `hooks`, `platforms`, `storage`, `telemetry`, `thumbnail`), and the server-side
rule compiler/enforcer (`rule`).

The package is Node-oriented at the platform boundary only: `node:*` imports are confined
to `crypto/node.ts`, `http/auth-node.ts`, and `http/server-factory-node.ts`, aggregated by
`platforms/node.ts`.

## Interface

### Package entry (`index.ts`)

- `index.ts` re-exports the client SDK and the server surface, so server users import
  collection/client types from one package — `[index.ts:CollectionService]`,
  `[../package.json:dependencies]`.
- App and presets: `Mira`, `MiraApp`, `MiraBuilder`, `defineRule`, `SqliteDatabase`,
  `NodePlatform`, `NodePlatformLayer`, `LocalFileStorage`, `S3CompatibleStorage` —
  `[app/index.ts:Mira]`, `[databases/sqlite.ts:SqliteDatabase]`,
  `[platforms/node.ts:NodePlatform]`, `[storage/local-preset.ts:LocalFileStorage]`.
- Collection services: `CollectionService`, `makeCollectionServiceLayer`, `RequestCtx`,
  `CursorPage`, `CollectionError` types, repository types — `[index.ts:CollectionService]`,
  `[index.ts:RequestCtx]`, `[index.ts:RepoRecord]`.
- Runtime services: `AppConfig`, `AppConfigLive`, `CryptoService`, `AuthService`,
  `hashPassword`, `verifyPassword`, `verifyJwt`, `TokenStore`, `TokenStoreLive`,
  `Repository`, `RepositoryLive` — `[index.ts:AppConfig]`, `[index.ts:CryptoService]`,
  `[index.ts:Repository]`.
- HTTP helpers: `CorsConfig`, `defaultCorsConfig`, `makeCorsMiddleware`,
  `catchCollectionErrors` — `[index.ts:CorsConfig]`, `[index.ts:makeCorsMiddleware]`,
  `[index.ts:catchCollectionErrors]`.
- Hooks: `HookService`, `makeHookServiceLayer`, `makeHookCollectionServiceLayer`
  (`HookCollectionService` itself is internal) — `[hooks/hook-service.ts:HookService]`.
- Cron and telemetry: `CronService`, `makeCronServiceLayer`, `CronNotFoundError`, cron
  context types; `makeSqliteTelemetryLayer`, `logCleanupCronDef`, `TelemetrySqlClient`,
  `ConsoleTelemetryLayer`, `makeConsoleTelemetryLayer` —
  `[cron/index.ts:CronService]`, `[telemetry/sqlite-logger.ts:makeSqliteTelemetryLayer]`,
  `[telemetry/index.ts:ConsoleTelemetryLayer]`.
- Plugin API (via `app/index.ts`): `MiraPlugin`, `onCollection`, `onCollectionSuccess`,
  `fromLayer`, `isMiraPlugin`, `applyRulesToCollections` — `[app/plugin.ts:MiraPlugin]`,
  `[app/app.ts:applyRulesToCollections]`.

### Components

- [app](./app/EGM.md) — `Mira.builder()` phantom-type builder, `MiraApp` layer graph, plugins, `serve()`.
- [cache](./cache/EGM.md) — TTL record/list cache and the cached collection-service decorator.
- [collection-service](./collection-service/EGM.md) — validation, rules, auth credentials, cursor pagination, hidden fields.
- [config](./config/EGM.md) — `_config`-backed `AppConfig`, JWT secret, S3 settings.
- [cron](./cron/EGM.md) — scheduled jobs, run-now, persisted last-run state.
- [crypto](./crypto/EGM.md) — `CryptoService` and the Node implementation.
- [databases](./databases/EGM.md) — `SqliteDatabase` preset and `MiraDatabase` shape.
- [dialect](./dialect/EGM.md) — SQL dialect contract, plan translation, SQLite rebuild/DDL.
- [hooks](./hooks/EGM.md) — plugin hook dispatch and the hook collection-service decorator.
- [http](./http/EGM.md) — REST routes, auth/session tokens, files, schema, telemetry, CORS, port retry.
- [migrator](./migrator/EGM.md) — schema diff, plan ordering, migration transactions.
- [platforms](./platforms/EGM.md) — Node platform layer aggregator and runtime preset.
- [repository](./repository/EGM.md) — schema-agnostic CRUD/list/view over `SqlClient`.
- [rule](./rule/EGM.md) — server-side rule compiler/enforcer.
- [storage](./storage/EGM.md) — `FileStorage`, local disk, S3-compatible storage.
- [telemetry](./telemetry/EGM.md) — console tracer/logger and SQLite persistence.
- [thumbnail](./thumbnail/EGM.md) — thumbnail service, Photon implementation, `_thumbs` cache.

## Invariants

- `index.ts` is the only public package surface; deep imports into component files are
  internal implementation details — `[../package.json:exports]`.
- `node:*` imports are confined to the platform-specific implementations
  (`crypto/node.ts`, `http/auth-node.ts`, `http/server-factory-node.ts`) and aggregated by
  `platforms/node.ts` — `[platforms/node.ts:NodePlatformLayer]`.
- The app builder requires `platform`, `database`, `storage`, and `collections` before
  `build()`; `rules`, `crons`, `telemetry`, `cors`, and `migrations` are optional —
  `[app/builder.ts:MiraBuilder.build]`.
- Auto-migration runs during layer construction before the HTTP server accepts requests;
  plugin layers are provided after the mid layer — `[app/app.ts:MiraApp.buildServiceLayer]`.
- The collection-service layer stack is hooks → cache → base — `[app/app.ts:MiraApp.buildServiceLayer]`.
- `Dialect` owns SQL rendering and table rebuilds; `Repository` stays schema-agnostic;
  `CollectionService` owns validation, rule evaluation, pagination, and hidden-field
  stripping — `[dialect/dialect.ts:Dialect]`, `[repository/repository.ts:Repository]`,
  `[collection-service/collection-service.ts:CollectionService]`.
- Boolean storage representation is a dialect concern (`storesBooleanAsInteger`), not a
  hardcoded SQLite assumption — `[dialect/dialect.ts:DialectType]`.
- Plugin-declared `adminCollections` are merged into the served collection set and their
  tokens receive `ctx.admin = true`, bypassing rules on generic collection/file routes —
  `[app/app.ts:MiraApp]`.
- Secrets are `Redacted`; `jwt_secret` is generated and persisted on first boot —
  `[config/config.ts:AppConfigLive]`.

## Side Effects

- SQL DDL/DML on boot: migrations, system tables (`_collections`, `_migrations`), token
  tables, `_config` seeding — `[app/app.ts:MiraApp.buildServiceLayer]`,
  `[migrator/migrator.ts:MigratorLive]`, `[http/token-store.ts:TokenStoreLive]`.
- HTTP server binding with port retry; request handling and cookies/JWTs —
  `[app/app.ts:MiraApp.buildLayer]`, `[http/router.ts:makeCollectionRouter]`.
- File storage reads/writes/deletes; thumbnail generation and `_thumbs` cache —
  `[storage/storage.ts:FileStorage]`, `[thumbnail/photon.ts:ThumbnailServicePhotonLive]`.
- Cron fibers, telemetry queues/spans, SQLite log persistence, and structured logging —
  `[cron/cron-service.ts:CronService]`, `[telemetry/tracer.ts:makeConsoleTracer]`,
  `[telemetry/sqlite-logger.ts:makeSqliteTelemetryLayer]`.
- Password hashing (scrypt), JWT signing/verification, and CSPRNG entropy —
  `[http/auth-node.ts:NodeAuthServiceLayer]`, `[http/auth.ts:signJwt]`,
  `[crypto/node.ts:NodeCryptoLayer]`.
- Plugin lifecycle/hook effects and route registration — `[app/plugin.ts:MiraPlugin]`.

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
