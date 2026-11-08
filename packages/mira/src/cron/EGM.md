# cron

## Overview

In-process cron scheduler for plugin-declared tasks. Each `CronDef` carries an
Effect `Schedule` and a handler; `makeCronServiceLayer` starts one scoped fiber
per definition, keeps a `Ref<HashMap>` snapshot of per-cron state, and exposes
`getAll`/`runNow` through the `CronService` tag. Last-run state is persisted in
the `_config` table under a single JSON blob (`cron_state`) so restarts resume
with the previous results, while the live `running`/`standby` status is never
persisted. `types.ts` holds `CronDef`, the hook context shapes and `CronState`;
`index.ts` is the public barrel.

## Interface

### `cron-service.ts`

- `CronService` — `Context.Service` tag with `getAll(): Effect<ReadonlyArray<CronState>>` and `runNow(name): Effect<void, CronNotFoundError>`. [cron-service.ts:CronService]
- `makeCronServiceLayer(defs)` — `Layer.effect` that validates names, loads persisted state, seeds the `Ref`, forks one scheduled fiber per definition, and returns the service. Generic over the handler requirement `R`. [cron-service.ts:makeCronServiceLayer]

### `persistence.ts`

- `CRON_STATE_CONFIG_KEY` — the `_config` key `"cron_state"`. [persistence.ts:CRON_STATE_CONFIG_KEY]
- `PersistedCronState` (type) — record of cron name → persisted entry; derived from `PersistedCronStateSchema`. [persistence.ts:PersistedCronState]
- `loadPersistedCronState(sql)` — ensures `_config` exists, reads the blob, and decodes it (falling back to `{}` on decode failure). [persistence.ts:loadPersistedCronState]
- `savePersistedCronState(sql, states)` — serializes all states and upserts the blob (`INSERT OR REPLACE`), swallowing failures as warnings. [persistence.ts:savePersistedCronState]

### `types.ts`

- `CronDef` (type) — `{ name, description?, schedule, handler }`; default handler requirement is `PlatformServices | AppConfig | Repository | CollectionService`. [types.ts:CronDef]
- `CronContext` (type) — `{ name, scheduledAt }`. [types.ts:CronContext]
- `CronResultContext` (type) — `{ name, scheduledAt, durationMs }`. [types.ts:CronResultContext]
- `CronErrorContext` (type) — `CronResultContext` plus `error`. [types.ts:CronErrorContext]
- `CronFinishedContext` (type) — `CronResultContext` plus `status` and `error | undefined`. [types.ts:CronFinishedContext]
- `CronState` (type) — `{ name, description, status: "standby" | "running", lastRunAt, lastStatus, lastDurationMs, lastError }`. [types.ts:CronState]
- `CronNotFoundError` — `Data.TaggedError("CronNotFoundError")` carrying the requested `name`. [types.ts:CronNotFoundError]

### `index.ts`

- Barrel re-exporting `CronService`, `makeCronServiceLayer`, `CronNotFoundError`, and the `CronDef`/context/state types. `persistence.ts` is not re-exported here. [index.ts:CronService]

No subdirectories.

## Invariants

- Cron names must be globally unique; a duplicate name dies at layer construction with `Duplicate cron name: "…"`. [cron-service.ts:makeCronServiceLayer]
- The first schedule tick is skipped (`skipFirst`), so a cron never runs at boot merely because the fiber started. [cron-service.ts:makeCronServiceLayer]
- Each definition gets its own scoped, repeating fiber (`Effect.repeat(def.schedule)` then `Effect.forkScoped`), so schedules die with the layer scope. [cron-service.ts:makeCronServiceLayer]
- Boot state is always seeded with `status: "standby"`; `lastRunAt`/`lastStatus`/`lastDurationMs`/`lastError` are restored from `cron_state` when present. [cron-service.ts:makeCronServiceLayer]
- `status` is never persisted — `PersistedCronEntrySchema` has no `status` key, so every boot starts from standby. [persistence.ts:PersistedCronEntrySchema]
- `status` is only `"running"` between the mark-running update and the completion update, and is reset to `"standby"` on both success and error paths. [cron-service.ts:executeAndTrack]
- `lastRunAt` is derived from the run's `startedAt` timestamp and `lastDurationMs` is measured with `Date.now()` around the handler. [cron-service.ts:executeAndTrack]
- `runNow` and the scheduled tick both fork `executeAndTrack` with `Effect.catchCause(() => Effect.void)`, so a failing handler is recorded but never produces an unhandled fiber failure. [cron-service.ts:runOneTick] [cron-service.ts:CronService]
- `runNow` on an unknown name fails with `CronNotFoundError` and performs no work. [cron-service.ts:CronService]
- The error branch extracts `Cause.findErrorOption` first, otherwise the first die-defect, records it as `lastError`, logs `[cron] error in "<name>"`, fires `runCronError`/`runCronFinished`, then re-fails with the original cause. [cron-service.ts:executeAndTrack]
- Hook order per tick is `runCronStart` → `runCronExecute` → (detached) run → `runCronSuccess`/`runCronError` + `runCronFinished`; the pre stages may rewrite the context, and only `scheduledAt` is consumed downstream (state keys come from `def.name`). [cron-service.ts:runOneTick]
- `loadPersistedCronState` creates `_config` if absent and returns `{}` (after a `logWarning`) when the stored JSON fails to decode. [persistence.ts:loadPersistedCronState]
- Persistence write failures are downgraded to `Effect.logWarning` and never propagate into the run. [persistence.ts:savePersistedCronState]
- `lastError` is round-tripped as `String(error)` / `null`, so stored errors are textual, not structured values. [persistence.ts:savePersistedCronState]
- `SqlClient` is a hard layer dependency (state storage), and `HookService` is resolved once at layer construction. [cron-service.ts:makeCronServiceLayer]
- `getAll` returns a plain array snapshot of the `Ref` contents, in HashMap iteration order. [cron-service.ts:CronService]

## Side Effects

- Forks scoped repeating fibers per definition — timers driven by `def.schedule`; they live as long as the layer scope. [cron-service.ts:makeCronServiceLayer]
- Forks detached fibers for each run and for cron observers, so `runNow` returns before the handler finishes. [cron-service.ts:CronService] [cron-service.ts:runOneTick]
- Reads and writes the `_config` table in the main application database (`SELECT … WHERE key = …`, `INSERT OR REPLACE`). [persistence.ts:loadPersistedCronState] [persistence.ts:savePersistedCronState]
- Creates the `_config` table via DDL on load. [persistence.ts:loadPersistedCronState]
- Emits `Effect.log` on handler failure and `Effect.logWarning` on decode/persist failure. [cron-service.ts:executeAndTrack] [persistence.ts:savePersistedCronState]
- Emits tracing spans `cron.execute`, `cron.server <name>`, `cron.persistence.load`, and `cron.persistence.save`. [cron-service.ts:executeAndTrack] [persistence.ts:loadPersistedCronState]
- No filesystem or network access of its own; handlers may perform any I/O.

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
