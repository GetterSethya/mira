# hooks

## Overview

Plugin lifecycle plumbing for the Mira server. `hook-service.ts` collects every
`MiraPlugin` passed to the app builder into a single `HookService` tag whose
methods dispatch to plugin-supplied handlers, and `hook-collection.ts` wraps
`CollectionService` so those handlers run around every record operation.
Blocking stages (pre and execute) run serially and may rewrite the hook context
that the next plugin sees. The decorator forwards the rewritten `data` for
create/update, `limit`/`filter`/`sort`/`select`/`expand` for list, and
`select`/`expand` for view; the original `cursor`, `id`, and `auth` still reach
the wrapped service. Observer stages (success, error, cron observers) are
detached so the request path never waits on them.
`types.ts` defines the context shapes, and `index.ts` is the public barrel
re-exported from `@gettersethya/mira`.

## Interface

### `hook-service.ts`

- `HookService` — `Context.Service` tag exposing the `runRecord*`, `runRecordList`, `runRecordView`, `runBootstrap`/`runServe`/`runTerminate`, and `runCron*` dispatchers. [hook-service.ts:HookService]
- `makeHookServiceLayer(plugins)` — builds `HookService` as a `Layer.succeed` over the given plugin list. [hook-service.ts:makeHookServiceLayer]

### `hook-collection.ts`

- `makeHookCollectionServiceLayer()` — decorator layer that produces `CollectionService` from `CollectionService | HookService`, injecting hooks around `list`/`view`/`create`/`update`/`delete`. [hook-collection.ts:makeHookCollectionServiceLayer]

### `types.ts`

- `AuthContext` (type) — `{ collection, record }` of the authenticated actor. [types.ts:AuthContext]
- `RequestContext` (type) — `{ auth, headers, query }`. [types.ts:RequestContext]
- `RecordHookContext` (type) — `{ collection, data, record, auth }` for create/update/delete stages. [types.ts:RecordHookContext]
- `ListHookContext` (type) — `{ collection, filter, sort, select, expand, cursor, limit, auth }`. [types.ts:ListHookContext]
- `ViewHookContext` (type) — `{ collection, id, select, expand, auth }`. [types.ts:ViewHookContext]
- `RecordResultContext` (type) — `RecordHookContext` plus `result`. [types.ts:RecordResultContext]
- `ListResultContext` (type) — `ListHookContext` plus `items` and `nextCursor`. [types.ts:ListResultContext]
- `ViewResultContext` (type) — `ViewHookContext` plus `result`. [types.ts:ViewResultContext]
- `HookErrorContext` (type) — `{ collection, action, error, auth }`. [types.ts:HookErrorContext]
- `CronContext` (type) — `{ name, scheduledAt }`. [types.ts:CronContext]
- `CronResultContext` (type) — `{ name, scheduledAt, durationMs }`. [types.ts:CronResultContext]
- `CronErrorContext` (type) — `CronResultContext` plus `error`. [types.ts:CronErrorContext]
- `CronFinishedContext` (type) — `CronResultContext` plus `status` and optional `error`. [types.ts:CronFinishedContext]

### `index.ts`

- Barrel re-exporting `makeHookCollectionServiceLayer`, `HookService`, `makeHookServiceLayer`, and all context types above from their owning modules. [index.ts:makeHookCollectionServiceLayer] [index.ts:makeHookServiceLayer]

No subdirectories.

## Invariants

- Pre/execute hooks run serially in plugin declaration order, threading the previous hook's returned context into the next plugin (`current = yield* plugin.on…(current)`). [hook-service.ts:makeHookServiceLayer]
- Any hook whose `collections` list omits the target collection name is skipped; a hook with no `collections` runs for every collection. [hook-service.ts:matchesCollection]
- Cron hooks obey the same rule via `crons`, defaulting to all crons. [hook-service.ts:matchesCron]
- `create` order is pre-hook → execute-hook → `inner.create` → success observer, and the inner call receives `execCtx.data`. [hook-collection.ts:makeHookCollectionServiceLayer]
- The decorator forwards hook rewrites selectively: list uses `hookCtx.limit`/`filter`/`sort`/`select`/`expand` but the original `cursor` and `ctx`; view uses `hookCtx.select`/`expand` but the original `id` and `ctx`; create/update use `execCtx.data`; delete uses the original `id` and `ctx`. [hook-collection.ts:makeHookCollectionServiceLayer]
- `update` and `delete` first load the stored record with `inner.view`, pass it as `record` (delete also as `data`) to the pre-hooks, then call the inner mutation. [hook-collection.ts:makeHookCollectionServiceLayer]
- On failure the matching error observer runs before the original `CollectionError` is re-raised (`Effect.andThen(Effect.fail(error))`), so observers cannot mask or replace the failure. [hook-collection.ts:makeHookCollectionServiceLayer]
- Observer failures never affect the request: success stages are wrapped in `Effect.catch(() => Effect.void)` by the decorator. [hook-collection.ts:makeHookCollectionServiceLayer]
- Observer hooks themselves are detached with `Effect.forkDetach` and their handlers are `Effect.orDie`-wrapped, so a defect stays in the forked fiber. [hook-service.ts:runRecordCreateSuccess] [hook-service.ts:runCronFinished]
- `runBootstrap` may require `AppConfig | CollectionService`; every other dispatcher is `never`-requirement and `never`-error. [hook-service.ts:HookService]
- `HookCollectionService` requires exactly `CollectionService | HookService` in its layer environment and yields both before constructing the facade. [hook-collection.ts:makeHookCollectionServiceLayer]
- Every wrapped method emits an internal span named `hook.<action>` with a `collection` attribute. [hook-collection.ts:makeHookCollectionServiceLayer]
- `toAuth` copies only `{ collection, record }` and maps `undefined` to `undefined`, so hook contexts never expose the raw `RequestCtx`. [hook-collection.ts:toAuth]

## Side Effects

- Forks detached fibers for every success/error/cron-observer dispatch (`Effect.forkDetach`), i.e. background work that outlives the calling effect. [hook-service.ts:runRecordCreateSuccess] [hook-service.ts:runCronFinished]
- Executes arbitrary plugin-supplied effects (pre/execute stages) inline, so plugin I/O blocks the request path until it completes. [hook-service.ts:makeHookServiceLayer]
- Emits internal tracing spans via `Effect.withSpan` for each wrapped collection action. [hook-collection.ts:makeHookCollectionServiceLayer]
- No filesystem, network, timer, or environment access in this directory.

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
