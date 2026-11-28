import { Cause, Context, Effect, Exit, HashMap, Layer, Option, Ref } from "effect"
import { SqlClient } from "effect/sql"

import { configTableDdl } from "@/config/config-sql.js"
import { Dialect } from "@/dialect/dialect.js"
import type { DialectType } from "@/dialect/dialect.js"
import { withStoreBootstrap } from "@/dialect/store-sql.js"
import { HookService as HookServiceTag } from "@/hooks/hook-service.js"

import { loadPersistedCronState, savePersistedCronState } from "./persistence.js"
import type { PersistedCronState } from "./persistence.js"
import type {
  CronContext,
  CronDef,
  CronErrorContext,
  CronFinishedContext,
  CronResultContext,
  CronState
} from "./types.js"
import { CronNotFoundError } from "./types.js"

export class CronService extends Context.Service<
  CronService,
  {
    getAll(): Effect.Effect<ReadonlyArray<CronState>, never, never>
    runNow(name: string): Effect.Effect<void, CronNotFoundError, never>
  }
>()("CronService") {}

function executeAndTrack<R>(
  def: CronDef<R>,
  stateRef: Ref.Ref<HashMap.HashMap<string, CronState>>,
  ctx: CronContext,
  hookService: Context.Service.Shape<typeof HookServiceTag>,
  env: Context.Context<R>,
  sql: SqlClient.SqlClient,
  dialect: DialectType
) {
  return Effect.gen(function* () {
    yield* Ref.update(stateRef, (m) => {
      const existing = HashMap.get(m, def.name)
      if (Option.isNone(existing)) return m
      return HashMap.set(m, def.name, { ...existing.value, status: "running" as const })
    })

    const startedAt = Date.now()
    const exit = yield* Effect.exit(
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- CronDef.handler deliberately accepts arbitrary user failures
      def.handler().pipe(Effect.withSpan("cron.execute", { kind: "internal" }))
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
      yield* savePersistedCronState(sql, updated, dialect)
      const resultCtx: CronResultContext = { name: def.name, scheduledAt: ctx.scheduledAt, durationMs }
      const finishedCtx: CronFinishedContext = {
        name: def.name,
        scheduledAt: ctx.scheduledAt,
        durationMs,
        status: "success",
        error: undefined
      }
      yield* Effect.forkDetach(hookService.runCronSuccess(resultCtx))
      yield* Effect.forkDetach(hookService.runCronFinished(finishedCtx))
    } else {
      const maybeFailure = Cause.findErrorOption(exit.cause)
      const defects = exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)
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
      yield* savePersistedCronState(sql, updated, dialect)
      yield* Effect.log(`[cron] error in "${def.name}": ${String(error)}`)
      const errorCtx: CronErrorContext = { name: def.name, scheduledAt: ctx.scheduledAt, durationMs, error }
      const finishedCtx: CronFinishedContext = {
        name: def.name,
        scheduledAt: ctx.scheduledAt,
        durationMs,
        status: "error",
        error
      }
      yield* Effect.forkDetach(hookService.runCronError(errorCtx))
      yield* Effect.forkDetach(hookService.runCronFinished(finishedCtx))
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- re-raises the handler's arbitrary failure cause
      return yield* Effect.failCause(exit.cause)
    }
  }).pipe(
    Effect.withSpan(`cron.server ${def.name}`, {
      kind: "server",
      attributes: { "cron.name": def.name, "cron.scheduled_at": ctx.scheduledAt.toISOString() }
    }),
    Effect.provideContext(env),
    Effect.ignoreCause
  )
}

function runOneTick<R>(
  def: CronDef<R>,
  stateRef: Ref.Ref<HashMap.HashMap<string, CronState>>,
  hookService: Context.Service.Shape<typeof HookServiceTag>,
  env: Context.Context<R>,
  sql: SqlClient.SqlClient,
  dialect: DialectType
) {
  return Effect.gen(function* () {
    const scheduledAt = new Date()
    let ctx: CronContext = { name: def.name, scheduledAt }
    ctx = yield* hookService.runCronStart(ctx)
    ctx = yield* hookService.runCronExecute(ctx)
    yield* Effect.forkDetach(executeAndTrack(def, stateRef, ctx, hookService, env, sql, dialect))
  })
}

export function makeCronServiceLayer<R>(defs: ReadonlyArray<CronDef<R>>) {
  return Layer.effect(
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
      const dialect = yield* Dialect

      const persisted: PersistedCronState =
        defs.length === 0
          ? {}
          : yield* Effect.gen(function* () {
              yield* withStoreBootstrap(sql, dialect.store, (tx) =>
                tx.unsafe(configTableDdl(dialect)).pipe(Effect.asVoid)
              )
              return yield* loadPersistedCronState(sql, dialect)
            })

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
          return runOneTick(def, stateRef, hookService, env, sql, dialect)
        }).pipe(Effect.repeat(def.schedule), Effect.forkScoped)
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
            yield* Effect.forkDetach(executeAndTrack(def, stateRef, ctx, hookService, env, sql, dialect))
          })
      })
    })
  )
}
