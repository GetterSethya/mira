import { SqliteClient } from "@effect/sql-sqlite-node"
import { Cause, Deferred, Effect, Exit, Layer, Option, Schedule, TestClock } from "effect"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { CronService, makeCronServiceLayer } from "@/cron/cron-service.js"
import type { CronDef } from "@/cron/types.js"
import { CronNotFoundError } from "@/cron/types.js"
import { makeHookServiceLayer } from "@/hooks/hook-service.js"

// Handlers are Effect.void stubs — R = never, but cron state persistence requires SqlClient
type StubCronDef = CronDef<never>

function makeUnitLayer(defs: ReadonlyArray<StubCronDef>) {
  return makeCronServiceLayer(defs).pipe(
    Layer.provide(makeHookServiceLayer([])),
    Layer.provide(SqliteClient.layer({ filename: ":memory:" }))
  )
}

describe("CronService unit tests", () => {
  it.effect("getAll() returns initial standby state for all registered crons", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      const states = yield* svc.getAll()
      expect(states).toHaveLength(2)
      for (const s of states) {
        expect(s.status).toBe("standby")
        expect(s.lastRunAt).toBeUndefined()
        expect(s.lastStatus).toBeUndefined()
        expect(s.lastDurationMs).toBeUndefined()
        expect(s.lastError).toBeUndefined()
      }
    }).pipe(
      Effect.provide(
        makeUnitLayer([
          { name: "job-a", schedule: Schedule.once, handler: () => Effect.void },
          { name: "job-b", schedule: Schedule.once, handler: () => Effect.void },
        ])
      )
    )
  )

  it.effect("successful cron (Schedule.once) updates state after tick", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      yield* TestClock.adjust("1 hours")
      yield* Effect.yieldNow()
      yield* Effect.sleep(0)
      const [state] = yield* svc.getAll()
      expect(state.status).toBe("standby")
      expect(state.lastStatus).toBe("success")
      expect(state.lastRunAt).toBeDefined()
      expect(state.lastDurationMs).toBeGreaterThanOrEqual(0)
    }).pipe(
      Effect.provide(
        makeUnitLayer([
          { name: "success-job", schedule: Schedule.once, handler: () => Effect.void },
        ])
      )
    )
  )

  it.effect("failing cron records error state", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      yield* TestClock.adjust("1 hours")
      yield* Effect.yieldNow()
      yield* Effect.sleep(0)
      const [state] = yield* svc.getAll()
      expect(state.lastStatus).toBe("error")
      expect(state.lastError).toBeDefined()
    }).pipe(
      Effect.provide(
        makeUnitLayer([
          {
            name: "fail-job",
            schedule: Schedule.once,
            handler: () => Effect.fail(new Error("boom") as never),
          },
        ])
      )
    )
  )

  it.effect("runNow fires handler immediately without clock adjustment", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      yield* svc.runNow("immediate-job")
      yield* Effect.yieldNow()
      yield* Effect.sleep(0)
      const [state] = yield* svc.getAll()
      expect(state.lastStatus).toBe("success")
    }).pipe(
      Effect.provide(
        makeUnitLayer([
          { name: "immediate-job", schedule: Schedule.once, handler: () => Effect.void },
        ])
      )
    )
  )

  it.effect("runNow('nonexistent') fails with CronNotFoundError", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      const result = yield* Effect.exit(svc.runNow("no-such-cron"))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const failure = Cause.failureOption(result.cause)
        expect(Option.isSome(failure)).toBe(true)
        if (Option.isSome(failure)) {
          expect(failure.value instanceof CronNotFoundError).toBe(true)
          expect((failure.value as CronNotFoundError).name).toBe("no-such-cron")
        }
      }
    }).pipe(
      Effect.provide(
        makeUnitLayer([
          { name: "some-job", schedule: Schedule.once, handler: () => Effect.void },
        ])
      )
    )
  )

  it.effect("two crons with different names both appear in getAll()", () =>
    Effect.gen(function* () {
      const svc = yield* CronService
      const states = yield* svc.getAll()
      expect(states).toHaveLength(2)
      const names = states.map((s) => s.name).sort()
      expect(names).toEqual(["alpha", "beta"])
    }).pipe(
      Effect.provide(
        makeUnitLayer([
          { name: "alpha", schedule: Schedule.once, handler: () => Effect.void },
          { name: "beta", schedule: Schedule.once, handler: () => Effect.void },
        ])
      )
    )
  )

  it.effect("duplicate cron name causes layer construction to die", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Effect.provide(
          Effect.void,
          makeUnitLayer([
            { name: "dup", schedule: Schedule.once, handler: () => Effect.void },
            { name: "dup", schedule: Schedule.once, handler: () => Effect.void },
          ])
        )
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const defects = Cause.defects(result.cause)
        expect(Array.from(defects).length).toBeGreaterThan(0)
      }
    })
  )

  it.effect("status is 'running' while handler is executing, then reverts to 'standby'", () =>
    Effect.gen(function* () {
      const latch = yield* Deferred.make<void>()

      const layer = makeUnitLayer([
        {
          name: "slow-job",
          schedule: Schedule.once,
          handler: () => Deferred.await(latch),
        },
      ])

      const svc = yield* CronService.pipe(Effect.provide(layer))
      yield* svc.runNow("slow-job")
      yield* Effect.yieldNow()

      const runningStates = yield* svc.getAll()
      expect(runningStates[0].status).toBe("running")

      yield* Deferred.succeed(latch, undefined)
      yield* Effect.yieldNow()
      yield* Effect.sleep(0)

      const doneStates = yield* svc.getAll()
      expect(doneStates[0].status).toBe("standby")
      expect(doneStates[0].lastStatus).toBe("success")
    })
  )
})
