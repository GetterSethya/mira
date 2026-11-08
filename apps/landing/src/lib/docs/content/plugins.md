A plugin is a typed object that contributes lifecycle hooks, record hooks, routes, collections, admin collections, and scheduled jobs to a Mira app. Attach it with `.extend(plugin)` after `build()`, and Mira runs its hooks around every matching collection operation. Every hook is optional, so a plugin can start as one log line and grow.

## Define and extend

```ts
import { Effect } from "effect"
import { Mira, MiraPlugin } from "@gettersethya/mira"

const AuditPlugin = MiraPlugin.define({
  onBootstrap: () => Effect.log("[audit] ready")
})

Mira.builder()
  // platform, database, storage, collections, rules...
  .build()
  .extend(AuditPlugin)
  .serve()
```

`MiraPlugin.define` tags the object. `MiraPlugin.fromLayer(layer)` wraps a plain requirement-free `Layer<never, never, never>` when you only need a service contribution. `MiraPlugin.isMiraPlugin(value)` checks the internal `_tag`; `extend()` itself does not call the guard, so pass a `MiraPlugin` rather than an arbitrary object.

A plugin may also contribute `layer` (merged after the app's mid layer, so it can use `AppConfig`, `Repository`, and platform services), `routes` (merged after the built-in collection routes), `collections`, `adminCollections`, and `crons`.

## Lifecycle hooks

| Hook | Runs | Requirements |
|---|---|---|
| `onBootstrap` | during layer startup, after the socket binds and before requests are handled | may use `AppConfig` and `CollectionService` |
| `onServe` | declared on the interface; the current `serve()` parks in `Layer.launch` before reaching it | none |
| `onTerminate` | declared on the interface, not invoked by `serve()` | none |

`serve()` runs `onBootstrap`; it does not reach `onServe` or `onTerminate` in the current launch flow. Put required cleanup on your platform's shutdown signal.

## Record hooks

Each action has four stages. For create they are `onRecordCreate` (pre), `onRecordCreateExecute`, `onRecordCreateSuccess`, and `onRecordCreateError`; update and delete have the same four names.

Every record hook accepts an optional `collections` allowlist; cron hooks use a `crons` allowlist. Omit it to run for all collections or crons. The `onCollection(collections, handler)` and `onCollectionSuccess(collections, handler)` helpers build the same record objects. Hooks require Effect in the host app; install `effect@^4`.

The contexts are `RecordHookContext` (`{ collection, data, record, auth }`), `RecordResultContext` (the same plus `result`), and `HookErrorContext` (`{ collection, action, error, auth }`).

For create, `record` is `undefined` and `data` is the payload. For update and delete, the decorator loads the row through the collection's `view` path, so `record` is view-rule-gated and hidden-field-stripped rather than a raw stored row; update's `data` carries the incoming patch, while delete passes that loaded row as both `record` and `data`. Pre and execute hooks return the next context, so returning `{ ...ctx, data: { ...ctx.data, ... } }` patches the write before the service sees it. Execute hooks run after the pre stage; the inner service call receives the execute stage's rewritten `data`.

## List and view hooks

`onRecordList` receives `ListHookContext` — `{ collection, filter, sort, select, expand, cursor, limit, auth }`; its success hook adds `items` and `nextCursor`, and its error hook receives `HookErrorContext`. `onRecordView` receives `ViewHookContext` — `{ collection, id, select, expand, auth }`; its success hook adds `result`. Use these to inject tenant filters or force a select list; the success stage is an observer and cannot change a record.

## Ordering and forwarding

Blocking stages run serially in plugin declaration order, and each handler returns the context the next plugin receives, so a later plugin sees earlier rewrites. These stages block the request; avoid slow I/O there.

Success and error stages are observers. They are detached with `Effect.forkDetach`, wrapped so a defect stays in that fiber, and the decorator catches their failures. The request never waits on them, and an observer cannot change the result. On failure the decorator re-raises the original `CollectionError` immediately; the detached error observer runs independently.

The decorator forwards rewrites selectively. A list hook may change `limit`, `filter`, `sort`, `select`, and `expand`; the original `cursor` and request context still reach the service. A view hook may change `select` and `expand`; the original `id` and context still reach the service. Create and update forward the execute stage's `data`; delete forwards the original `id` and context. Rewrites to `cursor`, `id`, and `auth` are not forwarded, so a hook cannot repaginate a list, redirect a read, or swap the caller identity.

## Admin collections

`adminCollections` is an array of auth collection definitions whose tokens receive `ctx.admin = true` on generic collection and protected-file routes, bypassing rule enforcement and hidden-field stripping for the whole request. The definitions are also merged into the served collection set automatically. For example:

```ts
adminCollections: [SuperAdminCollection]
```

Only auth collections belong here.

An app with no admin plugin has no bypass. The dashboard plugin is the canonical example: it declares `_superadmin` with deny-all rules and serves its API under `/_dashboard/`. See [Dashboard plugin](../dashboard/). Only declare a collection you intend to be all-powerful.

## Crons

A cron definition is `{ name, description?, schedule, handler }`. The schedule is an Effect `Schedule`, and the handler returns an Effect using the default services (`PlatformServices | AppConfig | Repository | CollectionService`).

```ts
import { Effect, Schedule } from "effect"
import { CollectionService, type CronDef } from "@gettersethya/mira"
import { PostCollection } from "./collections.js"

export const digestCron: CronDef = {
  name: "digest:hourly",
  description: "Count posts on the first page every hour",
  schedule: Schedule.cron("0 * * * *"),
  handler: () =>
    Effect.gen(function* () {
      const svc = yield* CollectionService
      const page = yield* svc.list(PostCollection, null, 100, { headers: {}, query: {}, admin: true })
      yield* Effect.logInfo(`[digest] ${page.items.length} posts on the first page`)
    })
}
```

Register it with `.crons([digestCron])` on the builder or with `crons` on a plugin. Names must be unique across the builder and every plugin; a duplicate dies at boot. Each definition gets a scoped fiber, and the first tick is skipped. `CronService.getAll()` returns state, and `CronService.runNow(name)` triggers a run.

Cron hooks follow the record stages: `onCronStart` and `onCronExecute` block and may rewrite the context, while `onCronSuccess`, `onCronError`, and `onCronFinished` are detached observers. Per tick: start, execute, the run, then success or error plus finished.

### Persisted last-run state

After each run, success or error, Mira writes one JSON blob to `_config` under the `cron_state` key, keyed by cron name. It stores `lastRunAt`, `lastStatus`, `lastDurationMs`, and `lastError`; boot restores those into `CronState`.

- `status` (`"standby"` or `"running"`) is never persisted; every boot starts from standby.
- Persistence write failures and corrupted stored JSON are logged as warnings; a bad blob falls back to empty state at boot.

`runNow` forks the run and returns before the handler finishes; it skips the start/execute hooks and still records the outcome. An unknown name fails with `CronNotFoundError`.

## Worked example

This plugin derives a slug on create and logs the result for `posts`.

```ts
import { Effect } from "effect"
import { MiraPlugin } from "@gettersethya/mira"

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export const SlugPlugin = MiraPlugin.define({
  onRecordCreate: {
    collections: ["posts"],
    handler: (ctx) =>
      Effect.succeed({
        ...ctx,
        data: { ...ctx.data, slug: slugify(String(ctx.data["title"] ?? "")) }
      })
  },

  onRecordCreateSuccess: {
    collections: ["posts"],
    handler: (ctx) =>
      Effect.log(`[slug] created ${String(ctx.result["id"])} as ${String(ctx.result["slug"])}`)
  }
})
```

Attach it to the built app with `.extend(SlugPlugin)`. The pre hook rewrites `data`; the success hook observes the stored record.

## Next steps

- [Server, storage, migrations, and telemetry](../server/) for builder wiring and `AppConfig`.
