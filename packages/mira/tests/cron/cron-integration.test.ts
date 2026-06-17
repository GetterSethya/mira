import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Deferred, Effect, Exit, Layer, Option, Schedule } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { CronService, makeCronServiceLayer } from "@/cron/cron-service.js"
import { CronNotFoundError } from "@/cron/types.js"
import type { CronDef } from "@/cron/types.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"
import { MiraPlugin } from "@/app/plugin.js"

type StubDef = CronDef<never>

// Minimal self-contained test layer: handler R = never, but cron state persistence requires SqlClient
function makeLayer(builderDefs: ReadonlyArray<StubDef>, plugins: ReadonlyArray<MiraPlugin> = []) {
  const allDefs: ReadonlyArray<StubDef> = [
    ...builderDefs,
    ...plugins.flatMap((p): ReadonlyArray<StubDef> => {
      const crons = p.crons
      return crons !== undefined ? (crons as ReadonlyArray<StubDef>) : []
    })
  ]
  return makeCronServiceLayer(allDefs).pipe(
    Layer.provide(makeHookServiceLayer(plugins)),
    Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
  )
}

describe("CronService integration", () => {
  it.effect("builder crons appear in getAll() with standby status", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      const states = yield* svc.getAll()
      assert.strictEqual(states.length, 1)
      const [state] = states
      assert.strictEqual(state.name, "builder-cron")
      assert.strictEqual(state.status, "standby")
      assert.isUndefined(state.lastRunAt)
      assert.isUndefined(state.lastStatus)
    }).pipe(
      Effect.provide(
        makeLayer([{ name: "builder-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }])
      )
    )
  )

  it.effect("plugin crons appear alongside builder crons in getAll()", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      const states = yield* svc.getAll()
      const names = states.map((s) => s.name).sort()
      assert.deepEqual(names, ["builder-cron", "plugin-cron"])
      for (const s of states) {
        assert.strictEqual(s.status, "standby")
      }
    }).pipe(
      Effect.provide(
        makeLayer(
          [{ name: "builder-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }],
          [
            MiraPlugin.define({
              crons: [{ name: "plugin-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }]
            })
          ]
        )
      )
    )
  )

  it.effect("runNow triggers handler immediately and records success", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      yield* svc.runNow("quick-cron")
      yield* Effect.yieldNow()
      yield* Effect.sleep(0)
      const [state] = yield* svc.getAll()
      assert.strictEqual(state.lastStatus, "success")
      assert.isDefined(state.lastRunAt)
    }).pipe(
      Effect.provide(
        makeLayer([{ name: "quick-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }])
      )
    )
  )

  it.effect("runNow with failing handler records error state", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      yield* svc.runNow("error-cron")
      yield* Effect.yieldNow()
      yield* Effect.sleep(0)
      const [state] = yield* svc.getAll()
      assert.strictEqual(state.lastStatus, "error")
      assert.isDefined(state.lastError)
    }).pipe(
      Effect.provide(
        makeLayer([
          {
            name: "error-cron",
            schedule: Schedule.duration("24 hours"),
            handler: () => Effect.fail(new Error("boom"))
          }
        ])
      )
    )
  )

  it.effect("runNow on nonexistent cron produces CronNotFoundError", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      const result = yield* Effect.exit(svc.runNow("not-registered"))
      assert.isTrue(Exit.isFailure(result))
      if (Exit.isFailure(result)) {
        const failure = Cause.failureOption(result.cause)
        assert.isTrue(Option.isSome(failure))
        if (Option.isSome(failure)) {
          assert.ok(failure.value instanceof CronNotFoundError)
          assert.strictEqual((failure.value as CronNotFoundError).name, "not-registered")
        }
      }
    }).pipe(
      Effect.provide(
        makeLayer([{ name: "some-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }])
      )
    )
  )

  it.effect("onCronSuccess hook fires when runNow completes successfully", () =>
    Effect.gen(function* () {
      const latch = yield* Deferred.make<void>()

      const plugin = MiraPlugin.define({
        onCronSuccess: {
          handler: (ctx) => Deferred.succeed(latch, void 0).pipe(Effect.as(ctx))
        }
      })

      const svc = yield* CronService.pipe(
        Effect.provide(
          makeLayer(
            [{ name: "hook-cron", schedule: Schedule.duration("24 hours"), handler: () => Effect.void }],
            [plugin]
          )
        )
      )
      yield* svc.runNow("hook-cron")
      yield* Deferred.await(latch)
    })
  )

  it.effect("onCronError hook fires when runNow handler fails", () =>
    Effect.gen(function* () {
      const latch = yield* Deferred.make<void>()

      const plugin = MiraPlugin.define({
        onCronError: {
          handler: (ctx) => Deferred.succeed(latch, void 0).pipe(Effect.as(ctx))
        }
      })

      const svc = yield* CronService.pipe(
        Effect.provide(
          makeLayer(
            [
              {
                name: "fail-hook-cron",
                schedule: Schedule.duration("24 hours"),
                handler: () => Effect.fail(new Error("intentional failure"))
              }
            ],
            [plugin]
          )
        )
      )
      yield* svc.runNow("fail-hook-cron")
      yield* Deferred.await(latch)
    })
  )
})
