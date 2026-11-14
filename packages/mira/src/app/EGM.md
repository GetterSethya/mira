# App (Mira builder, application assembly, plugins)

## Overview

Turns collection definitions plus platform/database/storage presets into a runnable Mira server. `Mira.builder()` returns a phantom-typed `MiraBuilder<Has>` that only allows `build()` once `platform`, `database`, `storage`, and `collections` have all been supplied. `build()` produces a `MiraApp`, which owns the entire Effect layer graph: foundation (database, storage, thumbnails, telemetry) → mid (repository, migrator, `AppConfig`, durable `TokenStore`) → plugin layers → auto-migration → cached/hooked collection service → cron fibers. `buildServiceLayer()` exposes that graph without a network bind for tests; `buildLayer()` adds the HTTP router and server (with CORS + IP annotation middleware); `serve()` launches it through the platform's `runMain` and runs plugin bootstrap/serve hooks. Plugins (`MiraPlugin`) contribute layers, routes, collections, admin collections, crons, and lifecycle/record hooks.

## Interface

- `Mira` — entry object exposing `builder()`: `[index.ts:Mira]`
- `MiraBuilder<Has, R>` — fluent, immutable builder. Required steps: `platform`, `database`, `storage`, `collections`; optional: `rules`, `crons`, `telemetry`, `cors`, `migrations`; terminal: `build`: `[builder.ts:MiraBuilder]`
- `MiraBuilder.platform(p)` — records a `MiraPlatform` and adds `"platform"` to the phantom type: `[builder.ts:MiraBuilder.platform]`
- `MiraBuilder.database(d)` — records a `MiraDatabase` and adds `"database"`: `[builder.ts:MiraBuilder.database]`
- `MiraBuilder.storage(s)` — records a `MiraStorage` and adds `"storage"`: `[builder.ts:MiraBuilder.storage]`
- `MiraBuilder.collections(c)` — records the collection definitions and adds `"collections"`: `[builder.ts:MiraBuilder.collections]`
- `MiraBuilder.rules(r)` — attaches server-only `RuleBinding`s (rejects duplicate bindings per collection): `[builder.ts:MiraBuilder.rules]`
- `MiraBuilder.crons(c)` — attaches cron definitions and widens the requirement type `R`: `[builder.ts:MiraBuilder.crons]`
- `MiraBuilder.telemetry(l)` — overrides telemetry layer and adds `"telemetry"`: `[builder.ts:MiraBuilder.telemetry]`
- `MiraBuilder.cors(c)` — validates and stores a `CorsConfig`: `[builder.ts:MiraBuilder.cors]`
- `MiraBuilder.migrations(m)` — stores `MigrateOptions` for auto-migration: `[builder.ts:MiraBuilder.migrations]`
- `MiraBuilder.build()` — requires all four required phantom tags; defaults telemetry, CORS, and migrations: `[builder.ts:MiraBuilder.build]`
- `MiraAppConfig` (type) — the fully-defaulted configuration consumed by `MiraApp`: `[builder.ts:MiraAppConfig]`
- `MiraApp<R>` — assembled application with `extend`, `buildServiceLayer`, `buildLayer`, `serve`, plus `_getConfig`/`_getExtras`/`_resolveAdminCollections` test accessors: `[app.ts:MiraApp]`
- `MiraApp.extend(plugin)` — appends a `MiraPlugin` and returns `this` for chaining: `[app.ts:MiraApp.extend]`
- `MiraApp.buildServiceLayer()` — full service graph (no HTTP bind), including auto-migration and cron fibers: `[app.ts:MiraApp.buildServiceLayer]`
- `MiraApp.buildLayer(options?)` — service graph plus router and server layer; called internally by `serve`: `[app.ts:MiraApp.buildLayer]`
- `MiraApp.serve(options?)` — starts the server through `MiraPlatform.runMain`, runs bootstrap and serve hooks: `[app.ts:MiraApp.serve]`
- `ServeOptions` (type) — `port?`, `maxPortAttempts?`: `[app.ts:ServeOptions]`
- `applyRulesToCollections(collections, rules)` — merges `RuleBinding`s onto collection schemas; exported: `[app.ts:applyRulesToCollections]`
- `RuleBinding` (type) — tagged `{ _tag: "RuleBinding", collectionName, ruleMap }`: `[define-rule.ts:RuleBinding]`
- `ViewRuleMap` (type) — `list?`/`view?` rules only, for view collections: `[define-rule.ts:ViewRuleMap]`
- `defineRule(collection, cb)` — overloaded per collection kind; auth overload adds system auth fields plus `selfId()`; base overload forbids `manage`: `[define-rule.ts:defineRule]`
- `MiraPlugin` — plugin contract (interface + value with `define`, `fromLayer`, `isMiraPlugin`): `[plugin.ts:MiraPlugin]`
- `RecordHook`, `RecordSuccessHook`, `ListHook`, `ListSuccessHook`, `CronHook`, `CronObserverHook` (types) — plugin hook shapes with optional `collections`/`crons` allowlists: `[plugin.ts:RecordHook]`
- `onCollection(collections, handler)` / `onCollectionSuccess(collections, handler)` — hook constructors: `[plugin.ts:onCollection]`
- `PlatformServices`, `DatabaseServices` (types) — service unions a preset must provide: `[types.ts:PlatformServices]`
- `MiraPlatform`, `MiraDatabase`, `MiraStorage` (types) — preset interfaces (`layer`, and for platform `runMain`): `[types.ts:MiraPlatform]`
- Barrel re-exports (`MigrateOptions`, `MiraApp`, `ServeOptions`, `MiraAppConfig`, `MiraBuilder`, `RuleBinding`, `defineRule`, hook types, `MiraPlugin`, `onCollection`, `onCollectionSuccess`, preset types) all name local symbols: `[index.ts:Mira]`

## Invariants

- `build()` is only callable once `platform`, `database`, `storage`, and `collections` are present, enforced by the phantom `Has` type; runtime re-checks via `isMiraAppConfig`: `[builder.ts:MiraBuilder.build]`
- `build()` defaults `telemetry` to `ConsoleTelemetryLayer`, `cors` to `defaultCorsConfig`, `rules`/`crons` to `[]`, `migrations` to `{}`: `[builder.ts:MiraBuilder.build]`
- `rules()` throws on a duplicate `collectionName` binding: `[builder.ts:MiraBuilder.rules]`
- `applyRulesToCollections` throws if a binding names a collection that is not in the provided list: `[app.ts:applyRulesToCollections]`
- Collection set = config collections (with rules applied) → plugin `collections` → `adminCollections`, deduped by name with the first occurrence winning (app config precedence): `[app.ts:#getAllCollections]`
- `adminCollections` are auto-merged into the served set and their names are passed to the router as the admin allowlist: `[app.ts:#getAdminCollections]`
- Cron names must be globally unique across config and plugin crons; boot dies on duplicates: `[app.ts:assertUniqueCronNames]`
- Auto-migration runs during layer initialization (before requests) and dies on failure: `[app.ts:MiraApp.buildServiceLayer]`
- Plugin layers are provided after the mid layer, so they may depend on `AppConfig`, `Repository`, and platform services: `[app.ts:MiraApp.buildServiceLayer]`
- The mid layer includes the rate-limit store, limiter, key secret, and email policy config. The default store is SQLite; `.rateLimits({ store, emailPolicies })` overrides it. `hookedEmail` is given the same `mid` output so it sees the SQLite `RateLimiter`, not the in-memory default: `[app.ts:MiraApp.buildServiceLayer]`
- Collection service layer stack is hook → cached → base; cron fibers are scoped to the service layer: `[app.ts:MiraApp.buildServiceLayer]`
- `buildLayer` route list is built-in collection routes first, then plugin routes: `[app.ts:MiraApp.buildLayer]`
- Middleware order is IP annotation wrapping CORS (`ipAnnotationMiddleware(makeCorsMiddleware(cors)(effect))`): `[app.ts:MiraApp.buildLayer]`
- Effective port is `options.port ?? AppConfig.port`, and the bound port is reported back through `cfg.updateBoundPort`: `[app.ts:MiraApp.buildLayer]`
- `cors()` rejects `credentials: true` combined with a wildcard/omitted origin list: `[builder.ts:MiraBuilder.cors]`
- `serve()` emits a warning when the permissive default CORS config is in use: `[app.ts:MiraApp.serve]`
- `serve()` runs `HookService.runBootstrap` during layer launch and `runServe` afterwards; `onTerminate` is declared on the plugin but is not invoked by `serve`: `[app.ts:MiraApp.serve]`

## Side Effects

- SQL DDL/DML: auto-migration applies the schema plan on boot (`Migrator.migrate`): `[app.ts:MiraApp.buildServiceLayer]`
- SQL: `TokenStoreLive` creates/uses `_revoked_tokens` and `_auth_generations` tables: `[app.ts:MiraApp.buildServiceLayer]`
- SQL: `SqliteRateLimitStoreLive` creates/uses `_rate_limits` and prunes expired buckets: `[app.ts:MiraApp.buildServiceLayer]`
- Network: binds an HTTP server, retrying ports on `EADDRINUSE` via `makePortRetryServerLayer`: `[app.ts:MiraApp.buildLayer]`
- Filesystem: storage preset is wired in the foundation layer (uploads/reads/deletes): `[app.ts:MiraApp.buildServiceLayer]`
- Filesystem: the platform's optional `thumbnailLayer` (default `ThumbnailServicePhotonLive`, Bun supplies `ThumbnailServiceBunLive`) is part of the foundation layer: `[app.ts:MiraApp.buildServiceLayer]`
- Timers/background fibers: cron service starts every configured cron as a scoped fiber: `[app.ts:MiraApp.buildServiceLayer]`
- Configuration/environment: port and bound-port callback come from `AppConfig`: `[app.ts:MiraApp.buildLayer]`
- Logging: warning when the permissive default CORS config is active: `[app.ts:MiraApp.serve]`
- Lifecycle callbacks: plugin `onBootstrap`/`onServe` effects execute on start: `[app.ts:MiraApp.serve]`
- Plugin side effects: plugin `layer` and `routes` are merged into the app graph/router: `[plugin.ts:MiraPlugin]`

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
