import { SqlClient } from "@effect/sql"
import { Cause, Context, Effect, Exit, HashMap, Layer, Option, Ref } from "effect"
import type { HookService } from "@/hooks/hook-service.js"
import type {
  CronContext,
  CronDef,
  CronErrorContext,
  CronFinishedContext,
  CronResultContext,
  CronState
} from "./types.js"
import { CronNotFoundError } from "./types.js"
import { HookService as HookServiceTag } from "@/hooks/hook-service.js"
import { loadPersistedCronState, savePersistedCronState } from "./persistence.js"

export class CronService extends Context.Tag("CronService")<
  CronService,
  {
    getAll(): Effect.Effect<ReadonlyArray<CronState>, never, never>
    runNow(name: string): Effect.Effect<void, CronNotFoundError, never>
  }
>() {}

function executeAndTrack<R>(
  def: CronDef<R>,
  stateRef: Ref.Ref<HashMap.HashMap<string, CronState>>,
  ctx: CronContext,
  hookService: HookService["Type"],
  env: Context.Context<R>,
  sql: SqlClient.SqlClient
) {
  return Effect.gen(function* () {
    yield* Ref.update(stateRef, (m) => {
      const existing = HashMap.get(m, def.name)
      if (Option.isNone(existing)) return m
      return HashMap.set(m, def.name, { ...existing.value, status: "running" as const })
    })

    const startedAt = Date.now()
    const exit = yield* Effect.exit(
      def.handler().pipe(
        Effect.provide(env),
        Effect.withSpan("cron.execute", { kind: "internal" })
      )
    )
    const durationMs = Date.now() - startedAt

    if (Exit.isSuccess(exit)) {
      const updated = yield* Ref.updateAndGet(stateRef, (m) =>
        HashMap.set(m, def.name, {
          name: def.name,
          description: def.description,
          status: "standby" as const,
          lastRunAt: new Date(startedAt),
          lastStatus: "success" as const,
          lastDurationMs: durationMs,
          lastError: undefined
        })
      )
      yield* savePersistedCronState(sql, updated)
      const resultCtx: CronResultContext = { name: def.name, scheduledAt: ctx.scheduledAt, durationMs }
      const finishedCtx: CronFinishedContext = {
        name: def.name,
        scheduledAt: ctx.scheduledAt,
        durationMs,
        status: "success",
        error: undefined
      }
      yield* Effect.forkDaemon(hookService.runCronSuccess(resultCtx))
      yield* Effect.forkDaemon(hookService.runCronFinished(finishedCtx))
    } else {
      const maybeFailure = Cause.failureOption(exit.cause)
      const defects = Array.from(Cause.defects(exit.cause))
      const error: unknown = Option.isSome(maybeFailure) ? maybeFailure.value : defects[0]
      const updated = yield* Ref.updateAndGet(stateRef, (m) =>
        HashMap.set(m, def.name, {
          name: def.name,
          description: def.description,
          status: "standby" as const,
          lastRunAt: new Date(startedAt),
          lastStatus: "error" as const,
          lastDurationMs: durationMs,
          lastError: error
        })
      )
      yield* savePersistedCronState(sql, updated)
      yield* Effect.log(`[cron] error in "${def.name}": ${String(error)}`)
      const errorCtx: CronErrorContext = { name: def.name, scheduledAt: ctx.scheduledAt, durationMs, error }
      const finishedCtx: CronFinishedContext = {
        name: def.name,
        scheduledAt: ctx.scheduledAt,
        durationMs,
        status: "error",
        error
      }
      yield* Effect.forkDaemon(hookService.runCronError(errorCtx))
      yield* Effect.forkDaemon(hookService.runCronFinished(finishedCtx))
      return yield* Effect.failCause(exit.cause)
    }
  }).pipe(
    Effect.withSpan(`cron.server ${def.name}`, {
      kind: "server",
      attributes: { "cron.name": def.name, "cron.scheduled_at": ctx.scheduledAt.toISOString() }
    })
  )
}

function runOneTick<R>(
  def: CronDef<R>,
  stateRef: Ref.Ref<HashMap.HashMap<string, CronState>>,
  hookService: HookService["Type"],
  env: Context.Context<R>,
  sql: SqlClient.SqlClient
) {
  return Effect.gen(function* () {
    const scheduledAt = new Date()
    let ctx: CronContext = { name: def.name, scheduledAt }
    ctx = yield* hookService.runCronStart(ctx)
    ctx = yield* hookService.runCronExecute(ctx)
    yield* Effect.forkDaemon(
      executeAndTrack(def, stateRef, ctx, hookService, env, sql).pipe(Effect.catchAllCause(() => Effect.void))
    )
  })
}

export function makeCronServiceLayer<R>(defs: ReadonlyArray<CronDef<R>>) {
  return Layer.scoped(
    CronService,
    Effect.gen(function* () {
      const seen = new Set<string>()
      for (const def of defs) {
        if (seen.has(def.name)) {
          return yield* Effect.die(new Error(`Duplicate cron name: "${def.name}". Cron names must be globally unique.`))
        }
        seen.add(def.name)
      }

      const hookService = yield* HookServiceTag
      const sql = yield* SqlClient.SqlClient

      const persisted = yield* loadPersistedCronState(sql)

      const initialEntries = defs.map((def): [string, CronState] => {
        const entry = persisted[def.name]
        return [
          def.name,
          {
            name: def.name,
            description: def.description,
            status: "standby" as const,
            lastRunAt: entry?.lastRunAt ? new Date(entry.lastRunAt) : undefined,
            lastStatus: entry?.lastStatus ?? undefined,
            lastDurationMs: entry?.lastDurationMs ?? undefined,
            lastError: entry?.lastError ?? undefined
          }
        ]
      })
      const stateRef = yield* Ref.make(HashMap.fromIterable(initialEntries))

      const env = yield* Effect.context<R>()

      for (const def of defs) {
        let skipFirst = true
        yield* Effect.suspend(() => {
          if (skipFirst) {
            skipFirst = false
            return Effect.void
          }
          return runOneTick(def, stateRef, hookService, env, sql)
        }).pipe(
          Effect.repeat(def.schedule),
          Effect.forkScoped
        )
      }

      return CronService.of({
        getAll: () => Ref.get(stateRef).pipe(Effect.map((m) => Array.from(HashMap.values(m)))),

        runNow: (name: string) =>
          Effect.gen(function* () {
            const def = defs.find((d) => d.name === name)
            if (def === undefined) {
              return yield* new CronNotFoundError({ name })
            }
            const scheduledAt = new Date()
            const ctx: CronContext = { name, scheduledAt }
            yield* Effect.forkDaemon(
              executeAndTrack(def, stateRef, ctx, hookService, env, sql).pipe(
                Effect.catchAllCause(() => Effect.void)
              )
            )
          })
      })
    })
  )
}
