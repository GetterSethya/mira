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
  env: Context.Context<R>
) {
  return Effect.gen(function* () {
    yield* Ref.update(stateRef, (m) => {
      const existing = HashMap.get(m, def.name)
      if (Option.isNone(existing)) return m
      return HashMap.set(m, def.name, { ...existing.value, status: "running" as const })
    })

    const startedAt = Date.now()
    const exit = yield* Effect.exit(def.handler().pipe(Effect.provide(env)))
    const durationMs = Date.now() - startedAt

    if (Exit.isSuccess(exit)) {
      yield* Ref.update(stateRef, (m) =>
        HashMap.set(m, def.name, {
          name: def.name,
          status: "standby" as const,
          lastRunAt: new Date(startedAt),
          lastStatus: "success" as const,
          lastDurationMs: durationMs,
          lastError: undefined
        })
      )
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
      yield* Ref.update(stateRef, (m) =>
        HashMap.set(m, def.name, {
          name: def.name,
          status: "standby" as const,
          lastRunAt: new Date(startedAt),
          lastStatus: "error" as const,
          lastDurationMs: durationMs,
          lastError: error
        })
      )
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
    }
  })
}

function runOneTick<R>(
  def: CronDef<R>,
  stateRef: Ref.Ref<HashMap.HashMap<string, CronState>>,
  hookService: HookService["Type"],
  env: Context.Context<R>
) {
  return Effect.gen(function* () {
    const scheduledAt = new Date()
    let ctx: CronContext = { name: def.name, scheduledAt }
    ctx = yield* hookService.runCronStart(ctx)
    ctx = yield* hookService.runCronExecute(ctx)
    yield* Effect.forkDaemon(executeAndTrack(def, stateRef, ctx, hookService, env))
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

      const initialEntries = defs.map((def): [string, CronState] => [
        def.name,
        {
          name: def.name,
          status: "standby" as const,
          lastRunAt: undefined,
          lastStatus: undefined,
          lastDurationMs: undefined,
          lastError: undefined
        }
      ])
      const stateRef = yield* Ref.make(HashMap.fromIterable(initialEntries))

      const env = yield* Effect.context<R>()

      for (const def of defs) {
        yield* Effect.void.pipe(
          Effect.andThen(() => runOneTick(def, stateRef, hookService, env)),
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
            yield* Effect.forkDaemon(executeAndTrack(def, stateRef, ctx, hookService, env))
          })
      })
    })
  )
}
